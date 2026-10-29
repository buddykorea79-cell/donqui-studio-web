import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { addManualSubtitle } from "../../src/lib/ai-edition/document/manualSubtitle";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { createImageClip, imageClipArgs, validateImageClipFrame } from "./imageClip";

vi.mock("electron", () => ({ app: undefined }));
const run = promisify(execFile);
describe("photo clips", () => {
	it.each([0, -1, 601, Number.NaN, Infinity])("rejects invalid duration %s", (duration) => {
		expect(() => imageClipArgs("photo.png", duration, "out.mp4")).toThrow();
	});
	it("keeps shell characters as a single input argument and limits CPU", () => {
		const args = imageClipArgs("photo & 한글.png", 3.5, "output.mp4");
		expect(args[args.indexOf("-i") + 1]).toBe("photo & 한글.png");
		expect(args[args.indexOf("-t") + 1]).toBe("3.5");
		expect(args).toContain("libopenh264");
		expect(args[args.indexOf("-threads") + 1]).toBe("2");
	});
	it("fills the project's frame, or shows the whole photo on black", () => {
		const filter = (args: string[]) => args[args.indexOf("-vf") + 1];
		const cover = imageClipArgs("p.png", 3, "o.mp4", { width: 1920, height: 1080, fit: "cover" });
		expect(filter(cover)).toBe(
			"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p",
		);
		const contain = imageClipArgs("p.png", 3, "o.mp4", {
			width: 1080,
			height: 1920,
			fit: "contain",
		});
		expect(filter(contain)).toContain("pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black");
		// Without a frame, a photo keeps its own shape within 1080p, as before.
		expect(filter(imageClipArgs("p.png", 3, "o.mp4"))).toContain(
			"force_original_aspect_ratio=decrease",
		);
		const uhd = imageClipArgs("p.png", 3, "o.mp4", { width: 3840, height: 2160, fit: "cover" });
		expect(uhd[uhd.indexOf("-b:v") + 1]).toBe("16M");
	});
	it("accepts only a frame H.264 can encode", () => {
		expect(validateImageClipFrame(undefined)).toBeUndefined();
		expect(validateImageClipFrame({ width: 1920, height: 1080, fit: "cover" })).toEqual({
			width: 1920,
			height: 1080,
			fit: "cover",
		});
		for (const frame of [
			{ width: 1921, height: 1080, fit: "cover" },
			{ width: 1920, height: 1080, fit: "stretch" },
			{ width: 8192, height: 4320, fit: "cover" },
			"1920x1080",
		])
			expect(() => validateImageClipFrame(frame)).toThrow();
	});
	it.runIf(process.env.MANGOPANG_INTEGRATION === "1")(
		"creates a decodable cached photo clip and export fixture",
		async () => {
			const ffmpeg = path.resolve("electron/native/bin/win32-x64/ffmpeg-shared.exe");
			const root = path.resolve(".local/validation");
			await mkdir(root, { recursive: true });
			const input = path.join(root, "photo 한글.png");
			await run(
				ffmpeg,
				["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=1", "-frames:v", "1", input],
				{ windowsHide: true },
			);
			const digest = async () =>
				createHash("sha256")
					.update(await readFile(input))
					.digest("hex");
			const before = await digest();
			const output = await createImageClip(input, 3.5, path.join(root, "cache"));
			const mtime = (await stat(output)).mtimeMs;
			expect(await createImageClip(input, 3.5, path.join(root, "cache"))).toBe(output);
			expect((await stat(output)).mtimeMs).toBe(mtime);
			expect(await digest()).toBe(before);
			await run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"], { windowsHide: true });
			const video = path.join(root, "full-video.mp4");
			await run(
				ffmpeg,
				[
					"-y",
					"-f",
					"lavfi",
					"-i",
					"color=c=teal:s=1280x720:r=30:d=2",
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
					video,
				],
				{ windowsHide: true },
			);
			const doc = createEmptyDocument({
				projectId: "mangopang-validation",
				title: "Mangopang Studio 사진·영상·자막 검증",
			});
			doc.assets = [
				{
					id: "photo",
					kind: "video",
					label: "사진 3.5초",
					originalPath: output,
					durationSec: 3.5,
					cameraTrack: null,
				},
				{
					id: "video",
					kind: "video",
					label: "전체 영상 2초",
					originalPath: video,
					durationSec: 2,
					cameraTrack: null,
				},
			];
			doc.project.primaryAssetId = "photo";
			doc.timeline.clips = [
				{
					id: "photo-clip",
					assetId: "photo",
					sourceStartSec: 0,
					sourceEndSec: 3.5,
					timelineStartSec: 0,
					timelineEndSec: 3.5,
					wordRefs: [],
					origin: "user",
					reason: "Test fixture",
				},
				{
					id: "video-clip",
					assetId: "video",
					sourceStartSec: 0,
					sourceEndSec: 2,
					timelineStartSec: 3.5,
					timelineEndSec: 5.5,
					wordRefs: [],
					origin: "user",
					reason: "Test fixture",
				},
			];
			const final = documentSchema.parse(
				addManualSubtitle(doc, {
					text: "사진과 전체 영상 · 자막 테스트",
					startSec: 0.5,
					endSec: 5,
				}),
			);
			await writeFile(path.join(root, "validation.openscreen"), JSON.stringify(final, null, 2));
		},
		60000,
	);
});
