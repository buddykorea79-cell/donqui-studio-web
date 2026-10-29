import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateClipEffectRequest } from "../../src/lib/clip-effects/catalog";
import { clipEffectCacheKey, createClipEffect, validateClipEffectRequest } from "./clipEffects";
import { clipSourceContentType, parseMediaRange, serveClipSource } from "./clipEffectsSource";

let root: string;
let request: CreateClipEffectRequest;
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "donqui-effect-test-"));
	request = {
		sourcePath: path.join(root, "source 한글 &.mp4"),
		startMs: 250,
		endMs: 1250,
		effect: "zoom-in",
		width: 320,
		height: 180,
	};
	await writeFile(request.sourcePath, "0123456789");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("effect inputs and content cache", () => {
	it.each([
		{ startMs: -1 },
		{ endMs: 251 },
		{ endMs: Infinity },
		{ endMs: 600_251 },
		{ width: 0 },
		{ height: Number.NaN },
		{ effect: "random" },
		{ sourcePath: "relative.mp4" },
	])("rejects invalid requests %j", (change) => {
		expect(() =>
			validateClipEffectRequest({ ...request, ...change } as CreateClipEffectRequest),
		).toThrow();
	});
	it("takes a photo or a video as the source, and nothing else", () => {
		expect(() => validateClipEffectRequest({ ...request, sourceKind: "image" })).not.toThrow();
		expect(() => validateClipEffectRequest({ ...request, sourceKind: "video" })).not.toThrow();
		expect(() =>
			validateClipEffectRequest({
				...request,
				sourceKind: "audio",
			} as unknown as CreateClipEffectRequest),
		).toThrow("Unknown clip source kind");
	});
	it("keeps a video's cache key as it was, and gives a photo its own", async () => {
		const video = await clipEffectCacheKey(request);
		expect(await clipEffectCacheKey({ ...request, sourceKind: "video" })).toBe(video);
		// The key renders were stored under before photos could take an effect.
		const legacy = createHash("sha256")
			.update(
				JSON.stringify({
					version: 2,
					fps: 30,
					startMs: 250,
					endMs: 1250,
					effect: "zoom-in",
					width: 320,
					height: 180,
				}),
			)
			.update("0123456789")
			.digest("hex");
		expect(video).toBe(legacy);
		expect(await clipEffectCacheKey({ ...request, sourceKind: "image" })).not.toBe(video);
	});
	it("invalidates cache on range, effect, and changed content at the same path", async () => {
		const original = await clipEffectCacheKey(request);
		expect(await clipEffectCacheKey(request)).toBe(original);
		expect(await clipEffectCacheKey({ ...request, startMs: 300 })).not.toBe(original);
		expect(await clipEffectCacheKey({ ...request, effect: "pan-left" })).not.toBe(original);
		await writeFile(request.sourcePath, "abcdefghij");
		expect(await clipEffectCacheKey(request)).not.toBe(original);
	});
});

describe("local clip source serving", () => {
	it("tells the headless browser what kind of file it is", () => {
		expect(clipSourceContentType("C:/footage/DJI_0017.MP4")).toBe("video/mp4");
		expect(clipSourceContentType("/tmp/screen.webm")).toBe("video/webm");
		expect(clipSourceContentType("C:/photos/SEA.JPG")).toBe("image/jpeg");
		expect(clipSourceContentType("/photos/a.png")).toBe("image/png");
		expect(clipSourceContentType("/photos/a.webp")).toBe("image/webp");
		expect(clipSourceContentType("/footage/a.mov")).toBe("video/mp4");
	});
	it.each([
		"bytes=10-",
		"bytes=3-1",
		"bytes=-0",
		"bytes=0-2,4-6",
		"nonsense",
	])("rejects unusable range %s", (value) => {
		expect(parseMediaRange(value, 10)).toBeNull();
	});
	it("only exposes the selected file and supports seek ranges and HEAD", async () => {
		const server = await serveClipSource(request.sourcePath);
		try {
			const partial = await fetch(server.sourceUrl, { headers: { Range: "bytes=2-5" } });
			expect(partial.status).toBe(206);
			expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
			expect(await partial.text()).toBe("2345");
			const suffix = await fetch(server.sourceUrl, { headers: { Range: "bytes=-3" } });
			expect(await suffix.text()).toBe("789");
			const head = await fetch(server.sourceUrl, { method: "HEAD" });
			expect(head.headers.get("content-length")).toBe("10");
			expect(await head.text()).toBe("");
			expect((await fetch(new URL("/package.json", server.sourceUrl))).status).toBe(404);
			expect((await fetch(server.sourceUrl, { headers: { Range: "bytes=99-" } })).status).toBe(416);
		} finally {
			await server.close();
		}
	});
});

const run = promisify(execFile);
describe("real Remotion rendering", () => {
	it.runIf(process.env.DONQUI_REMOTION_INTEGRATION === "1")(
		"keeps photo clips without an audio stream so they do not trigger speech recognition",
		async () => {
			const bin = path.resolve("electron/native/bin/win32-x64/ffmpeg-shared.exe");
			await run(
				bin,
				[
					"-y",
					"-f",
					"lavfi",
					"-i",
					"color=c=teal:s=320x180:r=30:d=2",
					"-an",
					"-c:v",
					"libopenh264",
					"-threads",
					"2",
					request.sourcePath,
				],
				{ windowsHide: true },
			);
			const output = await createClipEffect(request, path.join(root, "cache"), {
				bundlePath: path.resolve("dist-remotion/bundle"),
				runtimePath: path.resolve("dist-remotion/runtime"),
			});
			const probe = path.resolve("node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe");
			const result = await run(
				probe,
				["-v", "error", "-show_streams", "-show_format", "-of", "json", output.filePath],
				{ windowsHide: true },
			);
			const metadata = JSON.parse(result.stdout) as {
				format: { duration: string };
				streams: { codec_type: string }[];
			};
			expect(Number(metadata.format.duration)).toBeCloseTo(1, 1);
			expect(metadata.streams.map((stream) => stream.codec_type)).toEqual(["video"]);
			await run(bin, ["-v", "error", "-i", output.filePath, "-f", "null", "-"], {
				windowsHide: true,
			});
		},
		120_000,
	);

	it.runIf(process.env.DONQUI_REMOTION_INTEGRATION === "1")(
		"renders a trimmed clip with audio using the packaged runtime and preserves the original",
		async () => {
			const bin = path.resolve("electron/native/bin/win32-x64/ffmpeg-shared.exe");
			expect(existsSync(bin)).toBe(true);
			await run(
				bin,
				[
					"-y",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=320x180:rate=30:duration=2",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:duration=2",
					"-c:v",
					"libopenh264",
					"-threads",
					"2",
					"-c:a",
					"aac",
					"-shortest",
					request.sourcePath,
				],
				{ windowsHide: true },
			);
			const digest = async () =>
				createHash("sha256")
					.update(await readFile(request.sourcePath))
					.digest("hex");
			const before = await digest();
			const runtime = {
				bundlePath: path.resolve("dist-remotion/bundle"),
				runtimePath: path.resolve("dist-remotion/runtime"),
			};
			const output = await createClipEffect(request, path.join(root, "cache"), runtime);
			const mtime = (await stat(output.filePath)).mtimeMs;
			expect((await createClipEffect(request, path.join(root, "cache"), runtime)).filePath).toBe(
				output.filePath,
			);
			expect((await stat(output.filePath)).mtimeMs).toBe(mtime);
			expect(await digest()).toBe(before);
			const probe = path.resolve("node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe");
			const result = await run(
				probe,
				["-v", "error", "-show_streams", "-show_format", "-of", "json", output.filePath],
				{ windowsHide: true },
			);
			const metadata = JSON.parse(result.stdout) as {
				format: { duration: string };
				streams: { codec_type: string; width?: number; height?: number }[];
			};
			expect(Number(metadata.format.duration)).toBeCloseTo(1, 1);
			expect(metadata.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
			expect(metadata.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
				width: 320,
				height: 180,
			});
			await run(bin, ["-v", "error", "-i", output.filePath, "-f", "null", "-"], {
				windowsHide: true,
			});
		},
		120_000,
	);
});
