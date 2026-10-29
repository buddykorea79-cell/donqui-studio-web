// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { VClipWindowAnalysis, VClipWindowRequest, VClipWindowResult } from "./contract";
import { segmentIsSplit, useVClipStore, vclipKey } from "./store";
import { useVisionModelStore } from "./visionModels";

const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const drone = {
	id: "drone",
	kind: "video" as const,
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	cameraTrack: null,
};
const beach = {
	id: "beach",
	kind: "video" as const,
	label: "BEACH.MP4",
	originalPath: "C:/footage/BEACH.MP4",
	cameraTrack: null,
};
const key = vclipKey("p", drone.id);
const scores: Record<number, number> = { 0: 60, 5: 90, 10: 75, 15: 80 };

function analysis(request: VClipWindowRequest): VClipWindowAnalysis {
	return {
		startSec: request.startSec,
		endSec: request.endSec,
		score: scores[request.startSec] ?? 50,
		qualityScore: 70,
		reason: `window ${request.startSec}`,
		quality: { brightness: 0.8, motion: 0.6, sharpness: 0.7, stability: 0.9 },
		ai: {
			score: scores[request.startSec] ?? 50,
			category: "orbit",
			description: `바다 ${request.startSec}`,
			caption: `절벽 ${request.startSec}`,
			tags: [],
		},
		aiError: null,
		thumbnail: null,
	};
}

const api = {
	vclipProbe: vi.fn(),
	vclipAnalyzeWindow: vi.fn(),
	vclipCancel: vi.fn(),
	vclipListModels: vi.fn(),
};
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const initialVClip = useVClipStore.getState();
const initialVision = useVisionModelStore.getState();
const initialProject = useProjectStore.getState();

function document(extra: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		...createEmptyDocument({ projectId: "p", title: "V.Clip" }),
		assets: [drone, beach],
		...extra,
	};
}

const run = (id = drone.id) => useVClipStore.getState().runs[vclipKey("p", id)];

async function analyzed(id = drone.id) {
	await vi.waitFor(() => expect(["done", "failed", "canceled"]).toContain(run(id)?.status));
	return run(id);
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	useVClipStore.setState(initialVClip, true);
	useVisionModelStore.setState(
		{ ...initialVision, chosen: undefined, models: null, loading: false },
		true,
	);
	useProjectStore.setState({ projectId: "p", document: document(), saveDocument: save });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipListModels.mockResolvedValue({
		available: true,
		baseUrl: "http://127.0.0.1:11434",
		error: null,
		models: [
			{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" },
			{ name: "qwen3-vl:8b", size: 6, parameterSize: "8.8B" },
		],
	});
	api.vclipProbe.mockResolvedValue({
		success: true,
		durationSec: 20,
		width: 3840,
		height: 2160,
		fps: 29.97,
		hasAudio: false,
	});
	api.vclipAnalyzeWindow.mockImplementation(
		async (request: VClipWindowRequest): Promise<VClipWindowResult> => ({
			success: true,
			result: analysis(request),
		}),
	);
	api.vclipCancel.mockResolvedValue(undefined);
});
afterEach(() => {
	useProjectStore.setState(initialProject);
});

describe("analysis", () => {
	it("walks every window, then ranks and preselects the best three", async () => {
		useVClipStore.setState({ segmentSec: 5 });
		useVClipStore.getState().analyze(drone);
		const done = await analyzed();
		expect(done.status).toBe("done");
		expect(done.total).toBe(4);
		expect(done.completed).toBe(4);
		expect(done.segments.map((segment) => [segment.startSec, segment.selected])).toEqual([
			[0, false],
			[5, true],
			[10, true],
			[15, true],
		]);
	});

	it("asks the lightest installed vision model unless the user picked another", async () => {
		useVClipStore.getState().analyze(drone);
		await analyzed();
		expect(api.vclipAnalyzeWindow.mock.calls[0][0]).toMatchObject({ model: "qwen3-vl:4b" });
		expect(run().model).toBe("qwen3-vl:4b");

		useVisionModelStore.getState().choose("qwen3-vl:8b");
		useVClipStore.getState().analyze(beach);
		await analyzed(beach.id);
		expect(api.vclipAnalyzeWindow.mock.calls.at(-1)?.[0]).toMatchObject({ model: "qwen3-vl:8b" });

		useVisionModelStore.getState().choose(null);
		useVClipStore.getState().analyze(drone);
		await vi.waitFor(() => expect(run().model).toBeNull());
		await analyzed();
	});

	it("works through several videos one at a time", async () => {
		let running = 0;
		let most = 0;
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => {
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running--;
			return { success: true, result: analysis(request) };
		});
		useVClipStore.getState().analyzeAll([drone, beach]);
		expect(run(beach.id).status).toBe("queued");
		await analyzed();
		await analyzed(beach.id);
		expect(run(drone.id).status).toBe("done");
		expect(run(beach.id).status).toBe("done");
		expect(most).toBe(1);
		const sources = api.vclipAnalyzeWindow.mock.calls.map((call) => call[0].sourcePath);
		expect(sources.indexOf(beach.originalPath)).toBeGreaterThan(
			sources.lastIndexOf(drone.originalPath),
		);
	});

	it("takes a waiting video off the queue when it is cancelled", async () => {
		useVClipStore.getState().analyzeAll([drone, beach]);
		useVClipStore.getState().cancel(beach.id);
		expect(run(beach.id).status).toBe("idle");
		await analyzed();
		expect(
			api.vclipAnalyzeWindow.mock.calls.some((call) => call[0].sourcePath === beach.originalPath),
		).toBe(false);
	});

	it("puts a finished video back as it was when its new analysis is cancelled before starting", async () => {
		useVClipStore.getState().analyze(beach);
		await analyzed(beach.id);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		api.vclipAnalyzeWindow.mockImplementationOnce(async (request: VClipWindowRequest) => {
			await gate;
			return { success: true, result: analysis(request) };
		});
		useVClipStore.getState().analyzeAll([drone, beach]);
		expect(run(beach.id).status).toBe("queued");
		useVClipStore.getState().cancel(beach.id);
		expect(run(beach.id).status).toBe("done");
		expect(run(beach.id).segments).toHaveLength(4);
		release();
		await analyzed();
	});

	it("does not leave a video waiting in a project that was closed", async () => {
		api.vclipAnalyzeWindow.mockImplementationOnce(async (request: VClipWindowRequest) => {
			useProjectStore.setState({ projectId: "other" });
			return { success: true, result: analysis(request) };
		});
		useVClipStore.getState().analyzeAll([drone, beach]);
		expect(run(beach.id).status).toBe("queued");
		await vi.waitFor(() => expect(run(beach.id).status).toBe("idle"));
		expect(run(drone.id).status).toBe("canceled");
		expect(useVClipStore.getState().queue).toEqual([]);
	});

	it("says so when there is no desktop app to analyse with", async () => {
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { ...api, vclipAnalyzeWindow: undefined },
		});
		useVClipStore.getState().analyze(drone);
		await vi.waitFor(() => expect(run().status).toBe("failed"));
		expect(run().error).toMatch(/데스크톱 앱/);
	});

	it("stops when the project changes under it", async () => {
		api.vclipAnalyzeWindow.mockImplementationOnce(async (request: VClipWindowRequest) => {
			useProjectStore.setState({ projectId: "other" });
			return { success: true, result: analysis(request) };
		});
		useVClipStore.getState().analyze(drone);
		await vi.waitFor(() => expect(useVClipStore.getState().runs[key]?.status).toBe("canceled"));
		expect(api.vclipCancel).toHaveBeenCalled();
		expect(api.vclipAnalyzeWindow).toHaveBeenCalledTimes(1);
	});

	it("skips unreadable windows, and fails only when none could be read", async () => {
		api.vclipAnalyzeWindow.mockImplementationOnce(async () => ({
			success: false,
			error: "moov atom not found",
		}));
		useVClipStore.getState().analyze(drone);
		expect((await analyzed()).unreadable).toBe(1);
		expect(run().segments).toHaveLength(3);

		api.vclipAnalyzeWindow.mockResolvedValue({ success: false, error: "moov atom not found" });
		useVClipStore.getState().analyze(drone);
		await vi.waitFor(() => expect(run().status).toBe("failed"));
		expect(run().error).toBe("moov atom not found");
	});

	it("fails without analysing when the source cannot be probed", async () => {
		api.vclipProbe.mockResolvedValue({ success: false, error: "Invalid data" });
		useVClipStore.getState().analyze(drone);
		await vi.waitFor(() => expect(run().status).toBe("failed"));
		expect(run().error).toBe("Invalid data");
		expect(api.vclipAnalyzeWindow).not.toHaveBeenCalled();
	});

	it("keeps segments added by hand when it analyses again", async () => {
		await useVClipStore.getState().probe(drone);
		useVClipStore.getState().addManualSegment(drone);
		const manual = run().segments[0];
		useVClipStore.getState().analyze(drone);
		await analyzed();
		expect(run().segments.find((segment) => segment.id === manual.id)).toMatchObject({
			origin: "manual",
			selected: true,
		});
		// The hand-made 0–5 s range stands where the 0–5 s window would have gone.
		expect(run().segments.filter((segment) => segment.startSec === 0)).toHaveLength(1);
	});
});

describe("probing", () => {
	it("records what FFmpeg read on an asset the project knew nothing about", async () => {
		await useVClipStore.getState().probe(drone);
		await vi.waitFor(() =>
			expect(useProjectStore.getState().document?.assets[0]).toMatchObject({
				durationSec: 20,
				video: { width: 3840, height: 2160 },
			}),
		);
		expect(save.mock.calls[0][1]).toEqual({ history: false });
	});
});

describe("editing segments", () => {
	beforeEach(async () => {
		await useVClipStore.getState().probe(drone);
		save.mockClear();
	});

	it("adds a segment of the chosen clip length after the last one", () => {
		useVClipStore.getState().setSegmentSec(3);
		useVClipStore.getState().addManualSegment(drone);
		useVClipStore.getState().addManualSegment(drone);
		expect(run().segments.map((segment) => [segment.startSec, segment.endSec])).toEqual([
			[0, 3],
			[3, 6],
		]);
		expect(localStorage.getItem("donqui.vclip.segmentSec")).toBe("3");
	});

	it("adjusts a range within the source", () => {
		useVClipStore.getState().addManualSegment(drone);
		const id = run().segments[0].id;
		useVClipStore.getState().adjustSegment(drone.id, id, { startSec: 17, endSec: 26 }, "start");
		expect(run().segments[0]).toMatchObject({ startSec: 17, endSec: 20 });
	});

	it("gives every segment one length, pulling back the ones at the end", () => {
		useVClipStore.getState().addManualSegment(drone);
		useVClipStore.getState().addManualSegment(drone);
		useVClipStore.getState().adjustSegment(drone.id, run().segments[1].id, {
			startSec: 17,
			endSec: 20,
		});
		useVClipStore.getState().resizeAll([drone.id], 8);
		expect(run().segments.map((segment) => [segment.startSec, segment.endSec])).toEqual([
			[0, 8],
			[12, 20],
		]);
	});

	it("selects the best segments across videos to cover the audio", async () => {
		useVClipStore.getState().analyzeAll([drone, beach]);
		await analyzed();
		await analyzed(beach.id);
		const picked = useVClipStore.getState().selectToFill([drone.id, beach.id], 9);
		expect(picked).toBe(2);
		const selected = [run(drone.id), run(beach.id)].flatMap((current) =>
			current.segments.filter((segment) => segment.selected),
		);
		expect(selected.map((segment) => segment.analysis?.score)).toEqual([90, 90]);
	});
});

describe("splitting", () => {
	beforeEach(async () => {
		useVClipStore.getState().analyze(drone);
		await analyzed();
		save.mockClear();
	});

	it("puts the selected segments into Media's bin as ranges, one undo step", async () => {
		expect(await useVClipStore.getState().split([drone, beach])).toBe(3);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0][1]).toEqual({ history: true });
		const clips = useProjectStore.getState().document?.mediaBoard?.clips ?? [];
		expect(clips.map((clip) => [clip.assetId, clip.startSec, clip.endSec])).toEqual([
			["drone", 5, 10],
			["drone", 10, 15],
			["drone", 15, 20],
		]);
		expect(clips[0]).toMatchObject({
			label: "DJI_0017.MP4 · 0:05.0–0:10.0",
			score: 90,
			note: "절벽 5",
		});
		// Split and linked: nothing left to do for them.
		const document = useProjectStore.getState().document;
		const split = run().segments.filter((segment) => segmentIsSplit(segment, document));
		expect(split).toHaveLength(3);
		expect(split.every((segment) => !segment.selected)).toBe(true);
		expect(mocks.toastSuccess).toHaveBeenCalled();
	});

	it("splits a segment changed after its split into the same clip again", async () => {
		await useVClipStore.getState().split([drone]);
		const segment = run().segments.find((item) => item.startSec === 5);
		if (!segment) throw new Error("expected the 5 s segment");
		useVClipStore
			.getState()
			.adjustSegment(drone.id, segment.id, { startSec: 5, endSec: 12.5 }, "end");
		const changed = run().segments.find((item) => item.id === segment.id);
		expect(changed?.selected).toBe(true);
		expect(changed && segmentIsSplit(changed, useProjectStore.getState().document)).toBe(false);

		expect(await useVClipStore.getState().split([drone])).toBe(1);
		const clips = useProjectStore.getState().document?.mediaBoard?.clips ?? [];
		expect(clips).toHaveLength(3);
		expect(clips.find((clip) => clip.id === segment.clipId)).toMatchObject({
			startSec: 5,
			endSec: 12.5,
		});
	});

	it("takes the clip out of the bin when its segment is deleted", async () => {
		await useVClipStore.getState().split([drone]);
		const segment = run().segments.find((item) => item.clipId);
		if (!segment) throw new Error("expected a split segment");
		await useVClipStore.getState().removeSegment(drone.id, segment.id);
		expect(run().segments.some((item) => item.id === segment.id)).toBe(false);
		expect(
			useProjectStore
				.getState()
				.document?.mediaBoard?.clips.some((clip) => clip.id === segment.clipId),
		).toBe(false);
	});

	it("shows a reopened project's clips as split segments", async () => {
		await useVClipStore.getState().split([drone]);
		useVClipStore.setState({ runs: {} });
		useVClipStore.getState().toggleSegment(beach.id, "none");
		useVClipStore.getState().toggleSegment(drone.id, "none");
		expect(run().segments.map((segment) => [segment.origin, segment.startSec])).toEqual([
			["bin", 5],
			["bin", 10],
			["bin", 15],
		]);
		expect(
			run().segments.every((segment) =>
				segmentIsSplit(segment, useProjectStore.getState().document),
			),
		).toBe(true);
		expect(run(beach.id).segments).toEqual([]);
	});
});
