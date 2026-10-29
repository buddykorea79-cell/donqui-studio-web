// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubtitles, subtitleEntries } from "@/lib/ai-edition/document/subtitles";
import {
	type AxcutAsset,
	type AxcutDocument,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { patchOutputSettings, withFraming } from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { CreateClipEffectRequest } from "@/lib/clip-effects/catalog";
import {
	applyComposition,
	cancelApply,
	coverCrop,
	fillFrame,
	itemNeedsRender,
	placeOnTimeline,
} from "./apply";
import {
	addBoardImages,
	addBoardItems,
	boardOf,
	clipItem,
	imageItem,
	upsertBoardClips,
} from "./board";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const drone: AxcutAsset = {
	id: "drone",
	kind: "video",
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	durationSec: 60,
	video: { codec: "hevc", fps: 29.97, width: 3840, height: 2160 },
	cameraTrack: null,
};

function clip(id: string, assetId: string, start: number, end: number) {
	return {
		id,
		assetId,
		sourceStartSec: start,
		sourceEndSec: end,
		timelineStartSec: 0,
		timelineEndSec: end - start,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	};
}

/** Two clips of the drone footage on the timeline, a zoom and a voiceover anchored to them,
 *  and a composition: a clip as it is, the same clip zoomed, a still photo, a moving one. */
function project(): AxcutDocument {
	let document: AxcutDocument = {
		...createEmptyDocument({ projectId: "p", title: "Apply" }),
		assets: [drone],
	};
	document.timeline = {
		...document.timeline,
		clips: [
			clip("old-1", "drone", 0, 4),
			{ ...clip("old-2", "drone", 20, 26), timelineStartSec: 4, timelineEndSec: 10 },
		],
	};
	document.zoomRanges = [
		{
			id: "zoom",
			startMs: 1000,
			endMs: 2000,
			clipId: "old-1",
			sourceStartSec: 1,
			sourceEndSec: 2,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		},
	];
	document.audioTracks = [
		{
			...createAudioTrack({ assetId: "voice", durationSec: 3, kind: "voiceover" }),
			startMs: 5000,
			endMs: 8000,
			clipId: "old-2",
			sourceStartSec: 21,
			sourceEndSec: 24,
		},
		{ ...createAudioTrack({ assetId: "music", durationSec: 30 }), timelineLocked: true },
	];
	const bin = upsertBoardClips(document, [
		{ assetId: "drone", startSec: 3, endSec: 8, label: "DJI · 0:03" },
	]);
	const photos = addBoardImages(bin.document, [
		{ path: "C:/photos/sea.jpg", label: "sea.jpg", width: 4000, height: 3000 },
	]);
	const board = boardOf(photos.document);
	document = addBoardItems(photos.document, [
		clipItem(board.clips[0], { effect: "none" }),
		clipItem(board.clips[0], { effect: "zoom-in" }),
		imageItem(board.images[0], 4, { effect: "none" }),
		imageItem(board.images[0], 2.5, { effect: "pan-left" }),
	]);
	return document;
}

const api = {
	createClipEffect: vi.fn(),
	createImageClip: vi.fn(),
	vclipProbe: vi.fn(),
};
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const addAsset = vi.fn(async (path: string, label?: string) => {
	const state = useProjectStore.getState();
	if (!state.document) return null;
	const asset: AxcutAsset = {
		id: `asset-${state.document.assets.length}`,
		kind: "video",
		label: label ?? path,
		originalPath: path,
		cameraTrack: null,
	};
	useProjectStore.setState({
		document: { ...state.document, assets: [...state.document.assets, asset] },
	});
	return asset;
});
const initialProject = useProjectStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
	useProjectStore.setState({ projectId: "p", document: project(), saveDocument: save, addAsset });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.createClipEffect.mockImplementation(async (request: CreateClipEffectRequest) => ({
		success: true,
		filePath: `C:/cache/clip-effects/${request.sourceKind ?? "video"}-${request.effect}-${request.startMs}.mp4`,
		durationMs: request.endMs - request.startMs,
		width: 1920,
		height: 1080,
	}));
	api.createImageClip.mockImplementation(async (path: string, duration: number) => ({
		success: true,
		filePath: `C:/cache/image-clips/${duration}.mp4`,
		durationMs: duration * 1000,
		width: 1440,
		height: 1080,
	}));
});
afterEach(() => {
	useProjectStore.setState(initialProject);
});

describe("placing a composition", () => {
	it("replaces the timeline, pinning audio that was anchored to the clips it removes", () => {
		const document = project();
		const next = placeOnTimeline(
			document,
			[
				{ assetId: "drone", sourceStartSec: 3, sourceEndSec: 8 },
				{ assetId: "drone", sourceStartSec: 30, sourceEndSec: 32.5 },
			],
			"replace",
		);
		expect(
			next.timeline.clips.map((entry) => [
				entry.sourceStartSec,
				entry.sourceEndSec,
				entry.timelineStartSec,
				entry.timelineEndSec,
			]),
		).toEqual([
			[3, 8, 0, 5],
			[30, 32.5, 5, 7.5],
		]);
		expect(next.timeline.clips.every((entry) => !entry.id.startsWith("old"))).toBe(true);
		// The zoom belonged to a clip that is gone.
		expect(next.zoomRanges).toEqual([]);
		// The voiceover played at 5–8 s; it still does, now on the programme clock.
		const voice = next.audioTracks.find((track) => track.assetId === "voice");
		expect(voice).toMatchObject({ startMs: 5000, endMs: 8000, timelineLocked: true });
		expect(voice?.clipId).toBeUndefined();
		expect(next.audioTracks.find((track) => track.assetId === "music")).toMatchObject({
			timelineLocked: true,
		});
	});

	it("keeps subtitles typed in Edit at the time they showed at", () => {
		// Typed across the cut between the old clips, 3–6 s: it follows the narration, not them.
		const typed = addSubtitles(project(), [{ text: "남는 자막", startSec: 3, endSec: 6 }]).document;
		const next = placeOnTimeline(
			typed,
			[
				{ assetId: "drone", sourceStartSec: 3, sourceEndSec: 8 },
				{ assetId: "drone", sourceStartSec: 30, sourceEndSec: 32.5 },
			],
			"replace",
		);
		expect(subtitleEntries(next)).toEqual([
			expect.objectContaining({ text: "남는 자막", startSec: 3, endSec: 6, kind: "caption" }),
		]);
		// Anchored to the new clips, one fragment each side of their cut.
		const ids = new Set(next.timeline.clips.map((clip) => clip.id));
		expect(next.annotations.map((region) => ids.has(region.clipId ?? ""))).toEqual([true, true]);
		expect(next.zoomRanges).toEqual([]);
	});

	it("appends after the clips already there", () => {
		const next = placeOnTimeline(
			project(),
			[{ assetId: "drone", sourceStartSec: 40, sourceEndSec: 45 }],
			"append",
		);
		expect(next.timeline.clips.map((entry) => entry.timelineStartSec)).toEqual([0, 4, 10]);
		expect(next.zoomRanges).toHaveLength(1);
	});
});

describe("applying", () => {
	it("renders what needs it, plays the rest from its source, and places all in one edit", async () => {
		const progress = vi.fn();
		const result = await applyComposition("replace", progress);
		expect(result).toEqual({ placed: 4, skipped: 0 });

		expect(api.createClipEffect).toHaveBeenCalledTimes(2);
		// Rendered at the project's frame — 16:9 at 1080p by default. The 4K footage is already
		// that shape, so it asks for no fit, and its earlier renders stay cached.
		expect(api.createClipEffect.mock.calls[0][0]).toEqual({
			sourcePath: drone.originalPath,
			startMs: 3000,
			endMs: 8000,
			effect: "zoom-in",
			width: 1920,
			height: 1080,
		});
		// The 4:3 photo fills the 16:9 frame.
		expect(api.createClipEffect.mock.calls[1][0]).toMatchObject({
			sourcePath: "C:/photos/sea.jpg",
			sourceKind: "image",
			startMs: 0,
			endMs: 2500,
			effect: "pan-left",
			width: 1920,
			height: 1080,
			fit: "cover",
		});
		expect(api.createImageClip).toHaveBeenCalledWith("C:/photos/sea.jpg", 4, {
			width: 1920,
			height: 1080,
			fit: "cover",
		});

		const document = useProjectStore.getState().document;
		const clips = document?.timeline.clips ?? [];
		const pathOf = (assetId: string) =>
			document?.assets.find((asset) => asset.id === assetId)?.originalPath;
		expect(
			clips.map((entry) => [pathOf(entry.assetId), entry.sourceStartSec, entry.sourceEndSec]),
		).toEqual([
			[drone.originalPath, 3, 8],
			["C:/cache/clip-effects/video-zoom-in-3000.mp4", 0, 5],
			["C:/cache/image-clips/4.mp4", 0, 4],
			["C:/cache/clip-effects/image-pan-left-0.mp4", 0, 2.5],
		]);
		// Rendered media carries its real length and size.
		expect(document?.assets.find((asset) => asset.originalPath.endsWith("4.mp4"))).toMatchObject({
			durationSec: 4,
			video: { width: 1440, height: 1080 },
		});
		// One undoable edit for the timeline; the render metadata records nothing.
		const recorded = save.mock.calls.filter((call) => call[1].history);
		expect(recorded).toHaveLength(1);
		// And the picture fills Edit's frame instead of floating over the wallpaper.
		expect(getEditorSettings(document)).toMatchObject({ padding: 0, borderRadius: 0 });
		expect(progress).toHaveBeenCalledWith({ done: 0, total: 3, label: "DJI · 0:03" });
		expect(progress).toHaveBeenLastCalledWith({ done: 3, total: 3, label: "" });
	});

	it("does not list the same render twice when applied again", async () => {
		await applyComposition("replace");
		const assets = useProjectStore.getState().document?.assets.length;
		addAsset.mockClear();
		await applyComposition("append");
		expect(addAsset).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.assets.length).toBe(assets);
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(8);
	});

	it("skips items whose footage left the project", async () => {
		const document = useProjectStore.getState().document as AxcutDocument;
		useProjectStore.setState({
			document: { ...document, mediaBoard: { ...boardOf(document), images: [] } },
		});
		expect(await applyComposition("replace")).toEqual({ placed: 2, skipped: 2 });
	});

	it("places nothing once cancelled", async () => {
		api.createClipEffect.mockImplementationOnce(async (request: CreateClipEffectRequest) => {
			cancelApply();
			return {
				success: true,
				filePath: "C:/cache/x.mp4",
				durationMs: request.endMs - request.startMs,
			};
		});
		expect(await applyComposition("replace")).toBeNull();
		expect(useProjectStore.getState().document?.timeline.clips.map((entry) => entry.id)).toEqual([
			"old-1",
			"old-2",
		]);
		expect(api.createImageClip).not.toHaveBeenCalled();
	});

	it("fails loudly when a render fails", async () => {
		api.createClipEffect.mockResolvedValueOnce({ success: false, error: "no browser" });
		await expect(applyComposition("replace")).rejects.toThrow("no browser");
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(2);
	});

	it("renders at the frame the settings ask for", async () => {
		const document = useProjectStore.getState().document as AxcutDocument;
		useProjectStore.setState({
			document: patchOutputSettings(patchEditorSettings(document, { aspectRatio: "9:16" }), {
				resolution: "2160p",
				mediaFit: "contain",
			}),
		});
		await applyComposition("replace");
		expect(api.createClipEffect.mock.calls[0][0]).toMatchObject({
			width: 2160,
			height: 3840,
			fit: "contain",
		});
		expect(api.createImageClip).toHaveBeenCalledWith("C:/photos/sea.jpg", 4, {
			width: 2160,
			height: 3840,
			fit: "contain",
		});
		// Shown whole, footage played from its source is not cropped.
		const clips = useProjectStore.getState().document?.timeline.clips ?? [];
		expect(clips[0].cropRegion).toBeUndefined();
	});

	it("crops footage played from its source to the frame's shape", async () => {
		const document = useProjectStore.getState().document as AxcutDocument;
		useProjectStore.setState({ document: patchEditorSettings(document, { aspectRatio: "9:16" }) });
		await applyComposition("replace");
		const clips = useProjectStore.getState().document?.timeline.clips ?? [];
		expect(clips[0]).toMatchObject({
			assetId: "drone",
			cropRegion: { x: 0.3418, y: 0, width: 0.3164, height: 1 },
		});
	});

	it("knows which items need a render", () => {
		const items = boardOf(project()).items;
		expect(items.map(itemNeedsRender)).toEqual([false, true, true, true]);
	});
});

describe("filling the frame", () => {
	it("crops the middle of footage wider or taller than the frame, and nothing else", () => {
		expect(coverCrop({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toEqual({
			x: 0.3418,
			y: 0,
			width: 0.3164,
			height: 1,
		});
		expect(coverCrop({ width: 1440, height: 1080 }, { width: 1920, height: 1080 })).toEqual({
			x: 0,
			y: 0.125,
			width: 1,
			height: 0.75,
		});
		expect(coverCrop({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toBeUndefined();
	});

	it("leaves the layout alone once the user chose to float the picture", () => {
		const floating = withFraming(project(), "floating");
		expect(fillFrame(floating)).toBe(floating);
		expect(getEditorSettings(fillFrame(project()))).toMatchObject({
			padding: 0,
			borderRadius: 0,
			shadowIntensity: 0,
		});
	});
});
