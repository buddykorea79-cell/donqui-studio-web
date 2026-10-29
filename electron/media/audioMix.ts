import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveFfmpeg } from "./audioPeaks";

/** Every layer is resampled to this rate, and the mix is written at it. */
export const MIX_SAMPLE_RATE = 48000;
export const MAX_MIX_LAYERS = 32;
/** A guard against a malformed request, far past any soundtrack made here. */
export const MAX_MIX_SEC = 3 * 60 * 60;

export interface AudioMixLayer {
	path: string;
	/** Where the layer starts in the mix, in seconds. */
	startSec: number;
	/** The stretch of the file it plays, in source seconds. */
	inSec: number;
	outSec: number;
	/** Linear gain: 1 leaves the file as it is. */
	gain: number;
	fadeInSec: number;
	fadeOutSec: number;
}

export interface AudioMixRequest {
	layers: AudioMixLayer[];
	durationSec: number;
}

export interface AudioMixResult {
	filePath: string;
	durationSec: number;
	/** The loudest sample in dBFS, before it was written: above 0, the mix was clipped. */
	peakDb: number | null;
}

const within = (value: unknown, min: number, max: number): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** A request from the renderer, checked: its shape, and that every range and fade can be mixed. */
export function validateMixRequest(value: unknown): AudioMixRequest {
	const request = value as Partial<AudioMixRequest> | null;
	if (
		!request ||
		!Array.isArray(request.layers) ||
		request.layers.length === 0 ||
		request.layers.length > MAX_MIX_LAYERS
	)
		throw new Error(`Mix between 1 and ${MAX_MIX_LAYERS} layers`);
	const layers = request.layers.map((entry: unknown): AudioMixLayer => {
		const layer = (entry ?? {}) as Partial<AudioMixLayer>;
		if (typeof layer.path !== "string" || layer.path.length === 0)
			throw new Error("A layer has no file");
		const { startSec, inSec, outSec, gain, fadeInSec, fadeOutSec } = layer;
		if (
			!within(startSec, 0, MAX_MIX_SEC) ||
			!within(inSec, 0, MAX_MIX_SEC) ||
			!within(outSec, 0, MAX_MIX_SEC) ||
			outSec - inSec < 0.01
		)
			throw new Error("A layer's range is not valid");
		if (!within(gain, 0, 4)) throw new Error("A layer's volume is out of range");
		const span = outSec - inSec;
		if (
			!within(fadeInSec, 0, span) ||
			!within(fadeOutSec, 0, span) ||
			fadeInSec + fadeOutSec > span + 1e-6
		)
			throw new Error("A layer's fades do not fit it");
		return { path: layer.path, startSec, inSec, outSec, gain, fadeInSec, fadeOutSec };
	});
	const end = Math.max(...layers.map((layer) => layer.startSec + layer.outSec - layer.inSec));
	if (!within(request.durationSec, 0.01, MAX_MIX_SEC) || Math.abs(request.durationSec - end) > 0.01)
		throw new Error("The mix length does not match its layers");
	return { layers, durationSec: request.durationSec };
}

const num = (value: number) => String(Math.round(value * 1e6) / 1e6);

/**
 * One chain per layer — its range, volume and fades, then its place in the mix — summed without
 * renormalising, so a layer sounds as loud as it was set, then padded or cut to the exact length.
 * `channels` is each file's channel count: mono is spread to both sides at full level, as a
 * player does, where FFmpeg's own upmix would drop it by 3 dB.
 */
export function audioMixArgs(
	request: AudioMixRequest,
	channels: number[],
	output: string,
): string[] {
	const chains = request.layers.map((layer, index) => {
		const span = layer.outSec - layer.inSec;
		const steps = [
			`atrim=start=${num(layer.inSec)}:end=${num(layer.outSec)}`,
			"asetpts=PTS-STARTPTS",
			`aresample=${MIX_SAMPLE_RATE}`,
			channels[index] === 1 ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo",
			"aformat=sample_fmts=fltp",
			`volume=${num(layer.gain)}`,
			...(layer.fadeInSec > 0 ? [`afade=t=in:st=0:d=${num(layer.fadeInSec)}:curve=tri`] : []),
			...(layer.fadeOutSec > 0
				? [`afade=t=out:st=${num(span - layer.fadeOutSec)}:d=${num(layer.fadeOutSec)}:curve=tri`]
				: []),
			`adelay=delays=${Math.round(layer.startSec * MIX_SAMPLE_RATE)}S:all=1`,
		];
		return `[${index}:a:0]${steps.join(",")}[l${index}]`;
	});
	const inputs = request.layers.map((_, index) => `[l${index}]`).join("");
	const total = num(request.durationSec);
	const mix =
		`${inputs}amix=inputs=${request.layers.length}:duration=longest:dropout_transition=0:normalize=0,` +
		`apad=whole_dur=${total},atrim=end=${total},astats=metadata=0[mix]`;
	return [
		"-hide_banner",
		"-nostdin",
		"-nostats",
		"-y",
		"-loglevel",
		"info",
		...request.layers.flatMap((layer) => ["-i", layer.path]),
		"-filter_complex",
		[...chains, mix].join(";"),
		"-map",
		"[mix]",
		"-c:a",
		"pcm_s16le",
		"-ar",
		String(MIX_SAMPLE_RATE),
		"-ac",
		"2",
		output,
	];
}

/** The channel count of a file's first audio stream, from `ffmpeg -i`; null when it has none. */
export function parseAudioChannels(stderr: string): number | null {
	const line = stderr.split(/\r?\n/).find((entry) => /Stream #\d+:\d+.*: Audio: /.test(entry));
	const layout = line ? /, \d+ Hz, ([^,]+)/.exec(line)?.[1]?.trim() : undefined;
	if (!layout) return null;
	if (layout === "mono") return 1;
	if (layout === "stereo") return 2;
	const count = /^(\d+) channels/.exec(layout);
	// Anything else is a named surround layout (5.1, 7.1(wide), …): more than two.
	return count ? Number(count[1]) : 6;
}

/**
 * astats' overall peak, the last it prints; null for silence or when it printed nothing. Measured
 * in float, so it reads past 0 dB where volumedetect, which counts in 16 bits, stops at 0.
 */
export function parsePeakDb(stderr: string): number | null {
	const peaks = [...stderr.matchAll(/Peak level dB:\s*(-?\d+(?:\.\d+)?|-inf)/g)];
	const last = peaks.at(-1)?.[1];
	return last === undefined || last === "-inf" ? null : Number(last);
}

function run(command: string, args: string[], timeoutMs: number, anyExit = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-65536);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error("Mixing audio timed out"));
			else if (code === 0 || anyExit) resolve(stderr);
			else
				reject(
					new Error(`Mixing audio failed: ${stderr.trim().split(/\r?\n/).slice(-3).join(" / ")}`),
				);
		});
	});
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serial and content-addressed: the same layers over the same files give the same WAV, which is
 * reused as it is. The source files are only read.
 */
export function createAudioMix(
	request: AudioMixRequest,
	cacheDir: string,
): Promise<AudioMixResult> {
	const work = queue.then(() => mix(request, cacheDir));
	queue = work.catch(() => undefined);
	return work;
}

async function mix(request: AudioMixRequest, cacheDir: string): Promise<AudioMixResult> {
	const hash = createHash("sha256").update(
		JSON.stringify({ step: "audio-mix", version: 1, request }),
	);
	for (const layer of request.layers) {
		const source = await stat(layer.path);
		if (!source.isFile()) throw new Error(`Not a file: ${path.basename(layer.path)}`);
		hash.update(`\0${layer.path}\0${source.size}\0${source.mtimeMs}`);
	}
	await mkdir(cacheDir, { recursive: true });
	const base = path.join(cacheDir, hash.digest("hex"));
	const output = `${base}.wav`;
	const cached = await readFile(`${base}.json`, "utf8")
		.then((text) => JSON.parse(text) as { peakDb?: unknown })
		.catch(() => null);
	if (
		cached &&
		(await stat(output)
			.then((file) => file.size > 0)
			.catch(() => false))
	)
		return {
			filePath: output,
			durationSec: request.durationSec,
			peakDb: typeof cached.peakDb === "number" ? cached.peakDb : null,
		};
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg)
		throw new Error(
			"Mixing audio requires the bundled FFmpeg. Run the Donqui Studio runtime setup first.",
		);
	const channels: number[] = [];
	for (const layer of request.layers) {
		const count = parseAudioChannels(
			await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", layer.path], 60_000, true),
		);
		if (!count) throw new Error(`No audio in ${path.basename(layer.path)}`);
		channels.push(count);
	}
	const temporary = `${base}.${randomUUID()}.tmp.wav`;
	try {
		const stderr = await run(ffmpeg, audioMixArgs(request, channels, temporary), 30 * 60_000);
		if ((await stat(temporary)).size === 0) throw new Error("Mixing produced an empty file");
		const peakDb = parsePeakDb(stderr);
		await rename(temporary, output);
		await writeFile(`${base}.json`, JSON.stringify({ peakDb }));
		return { filePath: output, durationSec: request.durationSec, peakDb };
	} finally {
		await rm(temporary, { force: true });
	}
}
