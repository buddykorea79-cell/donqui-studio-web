import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioPlacement, chooseExportEncoding, exportVideo } from "./exportVideo";
import { createProject } from "./project";

vi.mock("mediabunny", async (importOriginal) => {
	const original = await importOriginal<typeof import("mediabunny")>();
	return { ...original, canEncodeVideo: vi.fn(), canEncodeAudio: vi.fn() };
});

describe("export codec negotiation", () => {
	beforeEach(() => vi.resetAllMocks());
	it("prefers MP4 when video and audio can both be encoded", async () => {
		vi.mocked(canEncodeVideo).mockResolvedValue(true);
		vi.mocked(canEncodeAudio).mockResolvedValue(true);
		expect(await chooseExportEncoding(1920, 1080, true)).toEqual({
			extension: "mp4",
			video: "avc",
			audio: "aac",
		});
		expect(canEncodeVideo).toHaveBeenCalledWith("avc", { width: 1920, height: 1080 });
	});
	it("falls back to WebM when AAC is absent without dropping sound", async () => {
		vi.mocked(canEncodeVideo).mockResolvedValue(true);
		vi.mocked(canEncodeAudio).mockImplementation(async (codec) => codec === "opus");
		expect(await chooseExportEncoding(1280, 720, true)).toEqual({
			extension: "webm",
			video: "vp9",
			audio: "opus",
		});
	});
	it("does not require an audio encoder for a silent project", async () => {
		vi.mocked(canEncodeVideo).mockResolvedValue(true);
		expect((await chooseExportEncoding(1280, 720, false)).extension).toBe("mp4");
		expect(canEncodeAudio).not.toHaveBeenCalled();
	});
	it("reports unsupported encoding instead of claiming a successful export", async () => {
		vi.mocked(canEncodeVideo).mockResolvedValue(false);
		await expect(chooseExportEncoding(1280, 720, false)).rejects.toThrow("Chrome");
	});
});

describe("audio trim and placement", () => {
	const segment = { start: 3, trimStart: 5, duration: 4 };
	it("trims a packet that straddles the beginning of the selected source", () => {
		expect(audioPlacement(segment, 4.5, 1, 0, 10)).toEqual({ when: 3, offset: 0.5, duration: 0.5 });
	});
	it("cuts the last packet at the selected source end", () => {
		expect(audioPlacement(segment, 8.5, 1, 0, 10)).toEqual({ when: 6.5, offset: 0, duration: 0.5 });
	});
	it("preserves timing when a source crosses an output audio block boundary", () => {
		expect(audioPlacement(segment, 6.5, 1, 5, 10)).toEqual({ when: 0, offset: 0.5, duration: 0.5 });
	});
	it("omits packets outside the timeline block", () => {
		expect(audioPlacement(segment, 7, 1, 8, 10)).toBeNull();
	});
});

describe("export preconditions", () => {
	it("rejects an empty timeline", async () => {
		await expect(exportVideo(createProject(), [])).rejects.toThrow("타임라인");
	});
	it("cancels before allocating codecs or reading files", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(exportVideo(createProject(), [], { signal: abort.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
