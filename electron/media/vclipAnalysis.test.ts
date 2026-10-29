import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VClipAiProposal, VClipWindowRequest } from "../../src/lib/vclip/contract";
import { resolveFfmpeg } from "./audioPeaks";
import type { SegmentFramesRequest } from "./ollamaVision";
import {
	analyzeWindow,
	type ExtractedFrame,
	extractFrame,
	frameBrightness,
	frameExtractArgs,
	frameMotion,
	frameSharpness,
	GRAY_HEIGHT,
	GRAY_WIDTH,
	heuristicScore,
	parseFfmpegProbe,
	probeVideo,
	sampledOffsetSec,
	thumbnailArgs,
	windowQuality,
} from "./vclipAnalysis";

/** `ffmpeg -i` on a DJI Mini 4 Pro file: 4K HEVC, DJI data streams, an MJPEG cover, no audio. */
const DJI_PROBE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'DJI_20260724084147_0017_D.MP4':
  Metadata:
    encoder         : DJI Mini4 Pro
  Duration: 00:02:46.77, start: 0.000000, bitrate: 92526 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 3840x2160, 89954 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
    Metadata:
      handler_name    : VideoHandler
  Stream #0:1[0x2](und): Data: none (djmd / 0x646D6A64), 76 kb/s
  Stream #0:2[0x3](und): Data: none (dbgi / 0x69676264), 2379 kb/s
  Stream #0:3[0x0]: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 1280x720 [SAR 1:1 DAR 16:9], 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`;

/** A phone clip filmed upright: stored landscape, displayed portrait. */
const PORTRAIT_PROBE = `  Duration: 00:00:12.50, start: 0.000000, bitrate: 17000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 16952 kb/s, 29.98 fps, 30 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 96 kb/s (default)`;

function gray(fill: (x: number, y: number) => number): Uint8Array {
	const pixels = new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT);
	for (let y = 0; y < GRAY_HEIGHT; y++)
		for (let x = 0; x < GRAY_WIDTH; x++) pixels[y * GRAY_WIDTH + x] = fill(x, y);
	return pixels;
}

describe("probing", () => {
	it("reads the picture stream and skips DJI's attached cover", () => {
		expect(parseFfmpegProbe(DJI_PROBE)).toEqual({
			durationSec: 166.77,
			width: 3840,
			height: 2160,
			fps: 29.97,
			hasAudio: false,
		});
	});

	it("swaps the size of a ±90° rotated stream, as players show it", () => {
		expect(parseFfmpegProbe(PORTRAIT_PROBE)).toMatchObject({
			width: 1080,
			height: 1920,
			hasAudio: true,
		});
	});

	it("gives up on output that names no video", () => {
		expect(parseFfmpegProbe("Duration: 00:00:03.00\n  Stream #0:0: Audio: mp3")).toBeNull();
		expect(parseFfmpegProbe("No such file or directory")).toBeNull();
	});
});

describe("frame extraction arguments", () => {
	it("seeks on the input and decodes only keyframes when asked", () => {
		const args = frameExtractArgs("C:/in put.mp4", 12.3456, "C:/out", true);
		const input = args.indexOf("-i");
		expect(args.slice(input - 4, input + 2)).toEqual([
			"-skip_frame",
			"nokey",
			"-ss",
			"12.346",
			"-i",
			"C:/in put.mp4",
		]);
		expect(args.filter((arg) => arg === "-frames:v")).toHaveLength(3);
		expect(args).toContain(path.join("C:/out", "gray.raw"));
	});

	it("decodes the exact frame otherwise", () => {
		expect(frameExtractArgs("in.mp4", 1, "out", false)).not.toContain("-skip_frame");
	});

	it("reads where the decoded frame sits relative to the seek point", () => {
		expect(
			sampledOffsetSec("[Parsed_showinfo_6 @ 0x1] n:   0 pts:    231 pts_time:0.231   duration:1"),
		).toBe(0.231);
		expect(sampledOffsetSec("nothing decoded")).toBeNull();
	});
});

describe("thumbnail arguments", () => {
	it("takes one small frame of the picture stream, keyframe first", () => {
		const args = thumbnailArgs("C:/footage/DJI_0017.MP4", 12.34, "C:/cache/t.jpg", true);
		expect(args.slice(args.indexOf("-skip_frame"), args.indexOf("-skip_frame") + 2)).toEqual([
			"-skip_frame",
			"nokey",
		]);
		expect(args[args.indexOf("-ss") + 1]).toBe("12.340");
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(args[args.indexOf("-map") + 1]).toBe("0:V:0");
		expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
		expect(args[args.indexOf("-vf") + 1]).toContain("min(320,iw)");
		expect(args.at(-1)).toBe("C:/cache/t.jpg");
		expect(thumbnailArgs("in.mp4", 1, "out.jpg", false)).not.toContain("-skip_frame");
	});
});

describe("frame quality", () => {
	it("scores detail above blur", () => {
		const flat = gray(() => 128);
		const checker = gray((x, y) => ((x + y) % 2 === 0 ? 30 : 220));
		expect(frameSharpness(flat)).toBe(0);
		expect(frameSharpness(checker)).toBeGreaterThan(0.9);
	});

	it("prefers mid-tones to black or blown-out frames", () => {
		expect(frameBrightness(gray(() => 0))).toBe(0);
		expect(frameBrightness(gray(() => 140))).toBeGreaterThan(0.95);
		expect(frameBrightness(gray(() => 255))).toBeLessThan(0.1);
	});

	it("sees no motion in a still and a lot in a cut", () => {
		const frame = gray((x) => x % 256);
		expect(frameMotion(frame, frame)).toBe(0);
		expect(
			frameMotion(
				frame,
				gray((x) => 255 - (x % 256)),
			),
		).toBeGreaterThan(0.9);
	});

	it("keeps the heuristic score inside AutoVeo's 55–95 band", () => {
		const still = gray(() => 0);
		expect(heuristicScore(windowQuality([still, still, still]))).toBeGreaterThanOrEqual(55);
		const lively = [0, 1, 2].map((shift) => gray((x, y) => ((x + y + shift * 8) % 32) * 6 + 40));
		const score = heuristicScore(windowQuality(lively));
		expect(score).toBeGreaterThan(70);
		expect(score).toBeLessThanOrEqual(95);
	});
});

describe("analyzeWindow", () => {
	let root: string;
	let request: VClipWindowRequest;
	const frame = (atSec: number): ExtractedFrame => ({
		atSec,
		jpeg: Buffer.from(`jpeg@${atSec}`),
		thumbnail: Buffer.from("thumb"),
		gray: gray((x, y) => ((x * 7 + y * 3 + Math.round(atSec * 10)) % 200) + 20),
	});
	const proposal: VClipAiProposal = {
		score: 88,
		category: "orbit",
		description: "해안 절벽을 도는 장면",
		caption: "절벽 위를 돌아",
		tags: ["cliff"],
	};

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "donqui-vclip-test-"));
		request = {
			jobId: "job",
			sourcePath: path.join(root, "DJI 0017.MP4"),
			startSec: 10,
			endSec: 15,
			model: "qwen3-vl:4b",
			title: "DJI 0017.MP4",
		};
		await writeFile(request.sourcePath, "not really a video");
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("scores with the model's judgement and caches the finished window", async () => {
		const extract = vi.fn(async (_source: string, atSec: number, _limitSec: number) =>
			frame(atSec),
		);
		const askModel = vi.fn(async (_request: SegmentFramesRequest) => proposal);
		const options = {
			cacheDir: path.join(root, "cache"),
			ollamaBaseUrl: "http://127.0.0.1:11434",
			extract,
			askModel,
		};
		const analysis = await analyzeWindow(request, options);
		expect(analysis).toMatchObject({ startSec: 10, endSec: 15, score: 88, aiError: null });
		expect(analysis.qualityScore).toBe(heuristicScore(analysis.quality));
		expect(analysis.reason).toBe(proposal.description);
		expect(analysis.thumbnail).toBe(
			`data:image/jpeg;base64,${Buffer.from("thumb").toString("base64")}`,
		);
		// Three samples, each bounded by the window's end.
		expect(extract.mock.calls.map((call) => [call[1], call[2]])).toEqual([
			[10.5, 15],
			[12.25, 15],
			[14, 15],
		]);
		expect(askModel.mock.calls[0][0]).toMatchObject({ model: "qwen3-vl:4b", durationSec: 5 });

		expect(await analyzeWindow(request, options)).toEqual(analysis);
		expect(extract).toHaveBeenCalledTimes(3);
		expect(askModel).toHaveBeenCalledTimes(1);
		// A different model is a different judgement.
		await analyzeWindow({ ...request, model: "qwen3-vl:8b" }, options);
		expect(askModel).toHaveBeenCalledTimes(2);
	});

	it("falls back to frame quality when the model fails, and asks again next time", async () => {
		const extract = vi.fn(async (_source: string, atSec: number) => frame(atSec));
		const askModel = vi.fn(async (): Promise<VClipAiProposal> => {
			throw new Error("Ollama returned HTTP 500");
		});
		const options = { cacheDir: path.join(root, "cache"), ollamaBaseUrl: "", extract, askModel };
		const analysis = await analyzeWindow(request, options);
		expect(analysis.ai).toBeNull();
		expect(analysis.aiError).toBe("Ollama returned HTTP 500");
		expect(analysis.score).toBe(heuristicScore(analysis.quality));
		expect(analysis.qualityScore).toBe(analysis.score);
		expect(await readdir(path.join(root, "cache")).catch(() => [])).toEqual([]);
		await analyzeWindow(request, options);
		expect(askModel).toHaveBeenCalledTimes(2);
	});

	it("scores from frame quality alone when no model is named", async () => {
		const askModel = vi.fn();
		const analysis = await analyzeWindow(
			{ ...request, model: null },
			{
				cacheDir: path.join(root, "cache"),
				ollamaBaseUrl: "",
				extract: async (_source, atSec) => frame(atSec),
				askModel,
			},
		);
		expect(askModel).not.toHaveBeenCalled();
		expect(analysis.aiError).toBeNull();
		expect(analysis.reason).toMatch(/선명|흐릿/);
	});

	it("lets a cancel through rather than recording it as a model failure", async () => {
		const controller = new AbortController();
		const askModel = vi.fn(async () => {
			controller.abort();
			throw new DOMException("Aborted", "AbortError");
		});
		await expect(
			analyzeWindow(request, {
				cacheDir: path.join(root, "cache"),
				ollamaBaseUrl: "",
				signal: controller.signal,
				extract: async (_source, atSec) => frame(atSec),
				askModel,
			}),
		).rejects.toThrow("Aborted");
	});
});

// Real FFmpeg against a synthetic clip. Opt in with DONQUI_VCLIP_INTEGRATION=1: it needs the
// bundled ffmpeg (electron/native/bin) and takes a few seconds.
describe.runIf(process.env.DONQUI_VCLIP_INTEGRATION === "1")("with the bundled FFmpeg", () => {
	let root: string;
	let video: string;
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "donqui-vclip-ffmpeg-"));
		video = path.join(root, "source 한글.mp4");
		const ffmpeg = resolveFfmpeg();
		if (!ffmpeg) throw new Error("No bundled ffmpeg");
		const made = spawnSync(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=640x360:rate=30",
				"-t",
				"6",
				"-c:v",
				"libopenh264",
				// A keyframe every second, as camera footage has.
				"-g",
				"30",
				video,
			],
			{ windowsHide: true, encoding: "utf8" },
		);
		expect(made.status, made.stderr).toBe(0);
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("probes and samples a keyframe inside the window", async () => {
		expect(await probeVideo(video)).toMatchObject({ width: 640, height: 360, hasAudio: false });
		const sampled = await extractFrame(video, 2.5, 4);
		expect(sampled.atSec).toBeGreaterThanOrEqual(2.5);
		expect(sampled.atSec).toBeLessThanOrEqual(4);
		expect(sampled.gray).toHaveLength(GRAY_WIDTH * GRAY_HEIGHT);
		expect(sampled.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		expect(frameSharpness(sampled.gray)).toBeGreaterThan(0.3);
	});

	it("decodes the exact frame when the next keyframe is past the window", async () => {
		const sampled = await extractFrame(video, 4.1, 4.5);
		expect(sampled.atSec).toBeGreaterThanOrEqual(4.1);
		expect(sampled.atSec).toBeLessThanOrEqual(4.5);
	});
});
