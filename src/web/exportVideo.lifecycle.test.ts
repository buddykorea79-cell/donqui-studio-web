import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportVideo } from "./exportVideo";
import { createClip, createProject, type WebAsset } from "./project";
import { drawFrame } from "./renderFrame";

const codec = vi.hoisted(() => ({
	frames: [] as Array<{ time: number; duration: number }>,
	cancel: vi.fn(),
	finalize: vi.fn(),
	closeBitmap: vi.fn(),
}));

vi.mock("./renderFrame", () => ({ drawFrame: vi.fn() }));
vi.mock("mediabunny", () => ({
	ALL_FORMATS: [],
	AudioBufferSink: class {},
	AudioBufferSource: class {},
	BlobSource: class {},
	CanvasSink: class {},
	Input: class {},
	Mp4OutputFormat: class {},
	WebMOutputFormat: class {},
	canEncodeVideo: async () => true,
	canEncodeAudio: async () => true,
	BufferTarget: class {
		buffer = new ArrayBuffer(8);
	},
	CanvasSource: class {
		async add(time: number, duration: number) {
			codec.frames.push({ time, duration });
		}
		close = vi.fn();
	},
	Output: class {
		addVideoTrack = vi.fn();
		addAudioTrack = vi.fn();
		start = vi.fn(async () => undefined);
		finalize = codec.finalize;
		cancel = codec.cancel;
	},
}));

describe("browser export lifecycle", () => {
	const asset: WebAsset = {
		id: "photo",
		name: "photo.png",
		kind: "image",
		blob: new Blob(["image"]),
		duration: 5,
		width: 400,
		height: 300,
	};
	beforeEach(() => {
		vi.clearAllMocks();
		codec.frames = [];
		codec.cancel.mockResolvedValue(undefined);
		codec.finalize.mockResolvedValue(undefined);
		vi.stubGlobal("document", {
			createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
		});
		vi.stubGlobal("createImageBitmap", async () => ({
			width: 400,
			height: 300,
			close: codec.closeBitmap,
		}));
	});
	afterEach(() => vi.unstubAllGlobals());
	it("keeps consecutive frame timestamps when clips are shorter than whole frames", async () => {
		const project = createProject();
		project.clips = [
			{ ...createClip(asset), duration: 0.05 },
			{ ...createClip(asset), duration: 0.05 },
		];
		const result = await exportVideo(project, [asset]);
		expect(codec.frames.map((frame) => frame.time)).toEqual([0, 1 / 30, 2 / 30]);
		expect(vi.mocked(drawFrame).mock.calls[2][2]?.id).toBe(project.clips[1].id);
		expect(vi.mocked(drawFrame).mock.calls[2][5]).toBeCloseTo(1 / 60);
		expect(result.extension).toBe("mp4");
		expect(result.blob.type).toBe("video/mp4");
		expect(codec.closeBitmap).toHaveBeenCalledTimes(2);
		expect(codec.finalize).toHaveBeenCalledOnce();
	});
	it("cancels an active encoder and releases image memory during an export", async () => {
		const project = createProject();
		project.clips = [createClip(asset)];
		const controller = new AbortController();
		await expect(
			exportVideo(project, [asset], {
				signal: controller.signal,
				onProgress: (progress) => {
					if (progress > 0) controller.abort();
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(codec.frames).toHaveLength(1);
		expect(codec.cancel).toHaveBeenCalledOnce();
		expect(codec.closeBitmap).toHaveBeenCalledOnce();
		expect(codec.finalize).not.toHaveBeenCalled();
	});
});
