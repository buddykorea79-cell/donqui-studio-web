import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	VClipAiProposal,
	VClipQuality,
	VClipWindowAnalysis,
	VClipWindowRequest,
} from "../../src/lib/vclip/contract";
import { resolveFfmpeg } from "./audioPeaks";
import { analyzeSegmentFrames } from "./ollamaVision";

/**
 * V.Clip segment analysis in the main process — AutoVeo's `detect-video-segments` step
 * (`video-clips.ts`, `video-quality.ts`), reworked for this app: ffmpeg does all decoding
 * (drone footage is 4K HEVC that Chromium may not decode), and the quality metrics run on
 * raw gray pixels instead of `sharp`.
 *
 * Sampling decodes KEYFRAMES ONLY. Seeking 4K HEVC to an exact timestamp costs 2–5 s a
 * frame; the keyframe at or after it costs ~0.5 s, and camera footage has one every second
 * or so. The exact decode remains as the fallback for sparse keyframes.
 */

/** Part of every cache key: bump it whenever sampling, scoring or the result's shape changes. */
export const VCLIP_ANALYSIS_VERSION = 2;

export const GRAY_WIDTH = 256;
export const GRAY_HEIGHT = 144;
/** AutoVeo's bound: three frames this size stay well inside a 4,096-token context. */
const AI_FRAME_BOX = 768;
const THUMB_BOX = 320;
/** Sample positions within a window; the last leaves a keyframe interval before its end. */
const SAMPLE_FRACTIONS = [0.1, 0.45, 0.8] as const;
const FFMPEG_TIMEOUT_MS = 60_000;

export interface VideoProbe {
	durationSec: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
}

export interface ExtractedFrame {
	/** Where the decoded frame actually sits, which keyframe sampling moves slightly later. */
	atSec: number;
	jpeg: Buffer;
	thumbnail: Buffer;
	gray: Uint8Array;
}

function abortError(): Error {
	return new DOMException("Aborted", "AbortError");
}

function requireFfmpeg(): string {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg)
		throw new Error("V.Clip needs the bundled FFmpeg. Run the Donqui Studio runtime setup first.");
	return ffmpeg;
}

function runFfmpeg(
	ffmpeg: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, FFMPEG_TIMEOUT_MS);
		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-65_536);
		});
		child.once("error", (error) => {
			finish();
			reject(error);
		});
		child.once("close", (code) => {
			finish();
			if (signal?.aborted) reject(abortError());
			else if (timedOut) reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS} ms`));
			else resolve({ code, stderr });
		});
	});
}

function lastLines(text: string, count = 3): string {
	return text.trim().split(/\r?\n/).slice(-count).join(" / ");
}

/**
 * Reads `ffmpeg -i` diagnostics. The picture stream is the first video stream that is not an
 * attached cover (DJI files carry a 1280×720 MJPEG one), and a ±90° display matrix swaps the
 * dimensions the way a player shows them.
 */
export function parseFfmpegProbe(stderr: string): VideoProbe | null {
	const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
	if (!duration) return null;
	const durationSec = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
	const lines = stderr.split(/\r?\n/);
	const videoIndex = lines.findIndex(
		(line) => /Stream #\d+:\d+.*: Video: /.test(line) && !/attached pic/.test(line),
	);
	if (!(durationSec > 0) || videoIndex < 0) return null;
	const video = lines[videoIndex];
	const size = / (\d{2,5})x(\d{2,5})[\s,[]/.exec(`${video} `);
	if (!size) return null;
	let width = Number(size[1]);
	let height = Number(size[2]);
	// Side data (the display matrix) is printed on the lines under its stream.
	const nextStream = lines.findIndex(
		(line, index) => index > videoIndex && /Stream #\d+:\d+/.test(line),
	);
	const sideData = lines.slice(videoIndex + 1, nextStream < 0 ? undefined : nextStream).join("\n");
	const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(sideData);
	if (rotation && Math.abs(Math.round(Number(rotation[1]))) % 180 === 90)
		[width, height] = [height, width];
	const fps = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(video);
	return {
		durationSec,
		width,
		height,
		fps: fps ? Number(fps[1]) : 0,
		hasAudio: lines.some((line) => /Stream #\d+:\d+.*: Audio: /.test(line)),
	};
}

export async function probeVideo(sourcePath: string, signal?: AbortSignal): Promise<VideoProbe> {
	// With no output file ffmpeg exits 1 after printing the input; that is the probe.
	const { stderr } = await runFfmpeg(
		requireFfmpeg(),
		["-hide_banner", "-nostdin", "-i", sourcePath],
		signal,
	);
	const probe = parseFfmpegProbe(stderr);
	if (!probe) throw new Error(`Could not read the video: ${lastLines(stderr)}`);
	return probe;
}

function boxScale(box: number): string {
	return `scale=w='min(${box},iw)':h='min(${box},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** One decode, three outputs: a frame for the model, a thumbnail, and gray pixels for metrics. */
export function frameExtractArgs(
	sourcePath: string,
	atSec: number,
	outDir: string,
	keyframesOnly: boolean,
): string[] {
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-loglevel",
		"info",
		"-threads",
		"1",
		...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
		"-ss",
		atSec.toFixed(3),
		"-i",
		sourcePath,
		"-filter_complex",
		// `V` (capital) skips attached cover pictures; showinfo reports the decoded frame's time.
		`[0:V:0]split=3[ai][thumb][gray];[ai]${boxScale(AI_FRAME_BOX)},format=yuvj420p[aiout];` +
			`[thumb]${boxScale(THUMB_BOX)},format=yuvj420p[thumbout];` +
			`[gray]scale=${GRAY_WIDTH}:${GRAY_HEIGHT},format=gray,showinfo[grayout]`,
		"-map",
		"[aiout]",
		"-frames:v",
		"1",
		"-q:v",
		"4",
		path.join(outDir, "ai.jpg"),
		"-map",
		"[thumbout]",
		"-frames:v",
		"1",
		"-q:v",
		"5",
		path.join(outDir, "thumb.jpg"),
		"-map",
		"[grayout]",
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		path.join(outDir, "gray.raw"),
	];
}

/** Time of the first frame showinfo saw, relative to the input seek point. */
export function sampledOffsetSec(stderr: string): number | null {
	const match = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
	return match ? Number(match[1]) : null;
}

/**
 * Decodes one frame at or just after `atSec`. The keyframe is taken unless it lies past
 * `limitSec` (the window's end), in which case the exact frame is decoded instead.
 */
export async function extractFrame(
	sourcePath: string,
	atSec: number,
	limitSec: number,
	signal?: AbortSignal,
): Promise<ExtractedFrame> {
	const ffmpeg = requireFfmpeg();
	const dir = await mkdtemp(path.join(os.tmpdir(), "donqui-vclip-"));
	try {
		let failure = "";
		for (const keyframesOnly of [true, false]) {
			const { code, stderr } = await runFfmpeg(
				ffmpeg,
				frameExtractArgs(sourcePath, atSec, dir, keyframesOnly),
				signal,
			);
			const offset = sampledOffsetSec(stderr);
			if (code !== 0 || offset === null) {
				failure = lastLines(stderr);
				continue;
			}
			const sampledAt = atSec + offset;
			if (keyframesOnly && sampledAt > limitSec) continue;
			const [jpeg, thumbnail, gray] = await Promise.all([
				readFile(path.join(dir, "ai.jpg")),
				readFile(path.join(dir, "thumb.jpg")),
				readFile(path.join(dir, "gray.raw")),
			]);
			if (jpeg.length === 0 || gray.length !== GRAY_WIDTH * GRAY_HEIGHT) {
				failure = "ffmpeg produced an incomplete frame";
				continue;
			}
			return { atSec: sampledAt, jpeg, thumbnail, gray: new Uint8Array(gray) };
		}
		throw new Error(
			`Could not read a frame at ${atSec.toFixed(2)} s${failure ? `: ${failure}` : ""}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** Laplacian variance, log-scaled to 0–1 as AutoVeo does: blur scores low, detail high. */
export function frameSharpness(gray: Uint8Array, width = GRAY_WIDTH, height = GRAY_HEIGHT): number {
	let sum = 0;
	let sumSquares = 0;
	let count = 0;
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const index = y * width + x;
			const laplacian =
				gray[index - width] +
				gray[index + width] +
				gray[index - 1] +
				gray[index + 1] -
				4 * gray[index];
			sum += laplacian;
			sumSquares += laplacian * laplacian;
			count++;
		}
	}
	if (count === 0) return 0;
	const mean = sum / count;
	return clamp(Math.log10(Math.max(0, sumSquares / count - mean * mean) + 1) / 3);
}

/** Mean luminance mapped the way AutoVeo rates it: best around mid-tones, poor at either end. */
export function frameBrightness(gray: Uint8Array): number {
	if (gray.length === 0) return 0;
	let sum = 0;
	for (const value of gray) sum += value;
	const average = sum / gray.length / 255;
	if (average < 0.15) return (average / 0.15) * 0.7;
	if (average > 0.9) return clamp((1 - average) / 0.1) * 0.7;
	if (average >= 0.35 && average <= 0.75) return 0.9 + 0.1 * (1 - Math.abs(average - 0.55) / 0.2);
	return clamp(0.5 + 0.5 * (1 - Math.abs(average - 0.5)));
}

/** Change between two frames on a 64-column grid: 0 for a still, 1 for a cut. */
export function frameMotion(
	previous: Uint8Array,
	current: Uint8Array,
	width = GRAY_WIDTH,
	height = GRAY_HEIGHT,
): number {
	const block = Math.max(1, Math.floor(width / 64));
	const columns = Math.floor(width / block);
	const rows = Math.floor(height / block);
	let difference = 0;
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			let a = 0;
			let b = 0;
			for (let dy = 0; dy < block; dy++) {
				const offset = (row * block + dy) * width + column * block;
				for (let dx = 0; dx < block; dx++) {
					a += previous[offset + dx];
					b += current[offset + dx];
				}
			}
			difference += Math.abs(a - b) / (block * block);
		}
	}
	return clamp((difference / (rows * columns) / 255) * 5);
}

/** AutoVeo's candidate quality: moderate, steady motion rates best; stills and shakes lower. */
export function windowQuality(frames: Uint8Array[]): VClipQuality {
	if (frames.length === 0) return { brightness: 0.5, motion: 0.5, sharpness: 0.5, stability: 0.5 };
	const average = (values: number[]) =>
		values.reduce((sum, value) => sum + value, 0) / values.length;
	const motions = frames.slice(1).map((frame, index) => frameMotion(frames[index], frame));
	const meanMotion = motions.length === 0 ? 0.5 : average(motions);
	const variance =
		motions.length > 1 ? average(motions.map((value) => (value - meanMotion) ** 2)) : 0;
	const motion =
		meanMotion < 0.05
			? (meanMotion / 0.05) * 0.6
			: meanMotion > 0.7
				? clamp((1 - meanMotion) / 0.3) * 0.6
				: 0.6 + 0.4 * (1 - Math.abs(meanMotion - 0.35) / 0.35);
	return {
		brightness: clamp(average(frames.map((frame) => frameBrightness(frame)))),
		motion: clamp(motion),
		sharpness: clamp(average(frames.map((frame) => frameSharpness(frame)))),
		stability: clamp(1 - variance * 20) * 0.7 + 0.3,
	};
}

/** 55–95, AutoVeo's weighting; used when no vision model judged the window. */
export function heuristicScore(quality: VClipQuality): number {
	return Math.round(
		clamp(
			quality.sharpness * 0.35 +
				quality.brightness * 0.25 +
				quality.stability * 0.25 +
				quality.motion * 0.15,
		) *
			40 +
			55,
	);
}

export function describeQuality(quality: VClipQuality): string {
	return [
		quality.sharpness >= 0.6 ? "선명함" : quality.sharpness >= 0.4 ? "보통 선명도" : "흐릿함",
		quality.brightness >= 0.7 ? "밝기 좋음" : "밝기 아쉬움",
		quality.stability >= 0.7 ? "흔들림 적음" : "흔들림 있음",
		quality.motion >= 0.6 ? "움직임 좋음" : "움직임 적음",
	].join(" · ");
}

/** One frame at `atSec` as a card thumbnail: the keyframe at or after it, or the exact frame. */
export function thumbnailArgs(
	sourcePath: string,
	atSec: number,
	output: string,
	keyframesOnly: boolean,
): string[] {
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-loglevel",
		"error",
		"-threads",
		"1",
		...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
		"-ss",
		atSec.toFixed(3),
		"-i",
		sourcePath,
		"-map",
		"0:V:0",
		"-frames:v",
		"1",
		"-vf",
		`${boxScale(THUMB_BOX)},format=yuvj420p`,
		"-q:v",
		"5",
		output,
	];
}

const THUMBNAIL_CACHE_VERSION = 1;
/** Cards ask for their thumbnails all at once; 4K HEVC decodes are heavy, so two at a time. */
const THUMBNAIL_CONCURRENCY = 2;
let thumbnailsRunning = 0;
const thumbnailWaiters: Array<() => void> = [];

async function withThumbnailSlot<T>(work: () => Promise<T>): Promise<T> {
	if (thumbnailsRunning >= THUMBNAIL_CONCURRENCY)
		await new Promise<void>((resolve) => thumbnailWaiters.push(resolve));
	else thumbnailsRunning++;
	try {
		return await work();
	} finally {
		// The slot passes straight to the next waiter, so nobody can slip in between.
		const next = thumbnailWaiters.shift();
		if (next) next();
		else thumbnailsRunning--;
	}
}

/**
 * A card thumbnail of `sourcePath` at `atSec` (to a tenth of a second), as a JPEG data URL.
 * Cached on disk by file identity and time, so a card seen once opens instantly afterwards.
 */
export async function sourceThumbnail(
	sourcePath: string,
	atSec: number,
	cacheDir: string,
): Promise<string> {
	if (!Number.isFinite(atSec) || atSec < 0) throw new Error("Choose a time inside the video");
	const source = await stat(sourcePath);
	if (!source.isFile()) throw new Error("The source video is unavailable");
	const at = Math.round(atSec * 10) / 10;
	const key = createHash("sha256")
		.update(
			JSON.stringify({
				version: THUMBNAIL_CACHE_VERSION,
				path: path.resolve(sourcePath),
				size: source.size,
				mtimeMs: source.mtimeMs,
				at,
				box: THUMB_BOX,
			}),
		)
		.digest("hex");
	const file = path.join(cacheDir, `${key}.jpg`);
	const toDataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;
	const cached = await readFile(file).catch(() => null);
	if (cached && cached.length > 0) return toDataUrl(cached);
	return withThumbnailSlot(async () => {
		await mkdir(cacheDir, { recursive: true });
		const temporary = path.join(cacheDir, `${randomUUID()}.tmp.jpg`);
		try {
			let failure = "";
			for (const keyframesOnly of [true, false]) {
				const { code, stderr } = await runFfmpeg(
					requireFfmpeg(),
					thumbnailArgs(sourcePath, at, temporary, keyframesOnly),
				);
				const jpeg = code === 0 ? await readFile(temporary).catch(() => null) : null;
				if (jpeg && jpeg.length > 0) {
					await rename(temporary, file).catch(() => undefined);
					return toDataUrl(jpeg);
				}
				failure = lastLines(stderr);
			}
			throw new Error(`Could not read a frame at ${at} s${failure ? `: ${failure}` : ""}`);
		} finally {
			await rm(temporary, { force: true });
		}
	});
}

export interface AnalyzeWindowOptions {
	cacheDir: string;
	ollamaBaseUrl: string;
	signal?: AbortSignal;
	/** Seams for tests. */
	extract?: typeof extractFrame;
	askModel?: typeof analyzeSegmentFrames;
}

async function readCachedAnalysis(file: string): Promise<VClipWindowAnalysis | null> {
	try {
		const cached = JSON.parse(await readFile(file, "utf8")) as VClipWindowAnalysis;
		return typeof cached?.score === "number" && typeof cached.reason === "string" ? cached : null;
	} catch {
		return null;
	}
}

/**
 * Scores one window: three sampled frames give the quality heuristic, and the vision model,
 * when one is named, gives the score, description and caption draft. A window is cached once
 * it is complete — a model failure is not, so the next run asks again.
 */
export async function analyzeWindow(
	request: VClipWindowRequest,
	options: AnalyzeWindowOptions,
): Promise<VClipWindowAnalysis> {
	const { startSec, endSec, model } = request;
	const source = await stat(request.sourcePath);
	if (!source.isFile()) throw new Error("The source video is unavailable");
	const key = createHash("sha256")
		.update(
			JSON.stringify({
				version: VCLIP_ANALYSIS_VERSION,
				// Path, size and mtime identify the footage without reading gigabytes of it.
				path: path.resolve(request.sourcePath),
				size: source.size,
				mtimeMs: source.mtimeMs,
				startSec,
				endSec,
				model,
			}),
		)
		.digest("hex");
	const cacheFile = path.join(options.cacheDir, `${key}.json`);
	const cached = await readCachedAnalysis(cacheFile);
	if (cached) return cached;

	const extract = options.extract ?? extractFrame;
	const span = endSec - startSec;
	const frames = await Promise.all(
		SAMPLE_FRACTIONS.map((fraction) =>
			extract(request.sourcePath, startSec + span * fraction, endSec, options.signal),
		),
	);
	const quality = windowQuality(frames.map((frame) => frame.gray));
	const qualityScore = heuristicScore(quality);
	let score = qualityScore;
	let reason = describeQuality(quality);
	let ai: VClipAiProposal | null = null;
	let aiError: string | null = null;
	if (model) {
		try {
			ai = await (options.askModel ?? analyzeSegmentFrames)(
				{
					baseUrl: options.ollamaBaseUrl,
					model,
					frames: frames.map((frame) => frame.jpeg),
					title: request.title,
					durationSec: span,
				},
				options.signal,
			);
			score = ai.score;
			if (ai.description) reason = ai.description;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			aiError = error instanceof Error ? error.message : String(error);
		}
	}
	const analysis: VClipWindowAnalysis = {
		startSec,
		endSec,
		score,
		qualityScore,
		reason,
		quality,
		ai,
		aiError,
		thumbnail: `data:image/jpeg;base64,${frames[1].thumbnail.toString("base64")}`,
	};
	if (!model || ai) {
		await mkdir(options.cacheDir, { recursive: true });
		const temporary = path.join(options.cacheDir, `${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, JSON.stringify(analysis));
			await rename(temporary, cacheFile);
		} catch {
			// The cache only saves time; a failed write must not fail the analysis.
			await rm(temporary, { force: true });
		}
	}
	return analysis;
}
