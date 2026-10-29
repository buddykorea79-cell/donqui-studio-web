import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	collapseTracksToPills,
	placeAudioTrackInDocument,
} from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import { isSubtitle } from "@/lib/ai-edition/document/subtitles";
import {
	projectRawTimelineSecToPlayback,
	removeClip,
	withClipsChanged,
} from "@/lib/ai-edition/document/timeline";
import type {
	AxcutAnnotationRegion,
	AxcutAsset,
	AxcutClip,
	AxcutDocument,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import {
	getFraming,
	getOutputSettings,
	hasChosenFraming,
	type MediaFit,
	projectOutputFrame,
	withFraming,
} from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import {
	anchorRegionsWithDerivedMs,
	coalesceRegionsForRuler,
} from "@/lib/ai-edition/timeline/timelineMap";
import {
	CLIP_EFFECTS,
	type ClipEffectId,
	type CreateClipEffectRequest,
	type CreateClipEffectResult,
} from "@/lib/clip-effects/catalog";
import { boardOf, itemDurationSec, resolvedItemEffect, samePath } from "./board";

/**
 * Media's composition onto Edit's timeline. Each item becomes one timeline clip: a clip or video
 * without an effect plays straight from its source; with an effect, or as a photo, it is
 * rendered first — Remotion for an effect, FFmpeg for a still — into a file the project then
 * uses as media. Renders are made at the project's output frame (설정: 화면 비율 and 화질), the
 * picture filling it or shown whole as the settings say, and the picture fills Edit's frame
 * rather than floating over a wallpaper. Renders are cached by content in the main process, so
 * applying an unchanged composition again costs nothing but the timeline write.
 */

export type ApplyMode = "replace" | "append";

export interface ApplyProgress {
	done: number;
	total: number;
	label: string;
}

export interface ApplyResult {
	placed: number;
	/** Items whose video or photo is gone from the project. */
	skipped: number;
}

interface Placement {
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** Set on footage played straight from its source whose shape differs from the frame's. */
	cropRegion?: CropRegion;
}

interface CropRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Frame {
	width: number;
	height: number;
}

/** Shapes this close are the same shape: a pixel of rounding is not a reason to crop. */
const SAME_SHAPE = 1e-3;

function sameShape(source: Frame, frame: Frame): boolean {
	return Math.abs(source.width / source.height - frame.width / frame.height) < SAME_SHAPE;
}

/**
 * The middle of `source` in the frame's shape: what a `cover` fit shows of footage that is
 * wider or taller than the frame. Undefined when the shapes already match.
 */
export function coverCrop(source: Frame, frame: Frame): CropRegion | undefined {
	if (source.width <= 0 || source.height <= 0 || sameShape(source, frame)) return undefined;
	const sourceAspect = source.width / source.height;
	const frameAspect = frame.width / frame.height;
	const round = (value: number) => Math.round(value * 10000) / 10000;
	if (sourceAspect > frameAspect) {
		const width = frameAspect / sourceAspect;
		return { x: round((1 - width) / 2), y: 0, width: round(width), height: 1 };
	}
	const height = sourceAspect / frameAspect;
	return { x: 0, y: round((1 - height) / 2), width: 1, height: round(height) };
}

export function clipEffectLabel(effect: ClipEffectId): string {
	return CLIP_EFFECTS.find((item) => item.id === effect)?.label ?? "효과 없음";
}

/** What applying will have to render: effect items and photos. The rest is instant. */
export function itemNeedsRender(item: AxcutMediaBoardItem): boolean {
	return item.kind === "image" || resolvedItemEffect(item) !== "none";
}

/**
 * A photo's pixel size, from the file itself; the render keeps its aspect ratio. Null when it
 * cannot be read in time — the render then falls back to a 16:9 frame.
 */
export function readImageSize(
	url: string,
	timeoutMs = 5000,
): Promise<{ width: number; height: number } | null> {
	return new Promise((resolve) => {
		if (typeof Image === "undefined") {
			resolve(null);
			return;
		}
		const image = new Image();
		const timer = setTimeout(() => resolve(null), timeoutMs);
		image.onload = () => {
			clearTimeout(timer);
			resolve(
				image.naturalWidth > 0 && image.naturalHeight > 0
					? { width: image.naturalWidth, height: image.naturalHeight }
					: null,
			);
		};
		image.onerror = () => {
			clearTimeout(timer);
			resolve(null);
		};
		image.src = url;
	});
}

/**
 * The composition laid out on the timeline, pure: `replace` swaps out every clip (the way
 * deleting them one by one would, so what was anchored to them goes too), `append` adds after
 * the last. Audio anchored to a replaced clip would go with it; it is pinned to the programme
 * time it played at instead, the way audio-first tracks already are. Subtitles typed in Edit
 * follow the narration, not the pictures, so they too stay at the time they showed at — going
 * back to Media to change a picture does not take the subtitles with it.
 */
export function placeOnTimeline(
	document: AxcutDocument,
	placements: Placement[],
	mode: ApplyMode,
): AxcutDocument {
	const clips: AxcutClip[] = placements.map((placement) => {
		const length = Math.max(0.001, placement.sourceEndSec - placement.sourceStartSec);
		return {
			id: createId("clip"),
			assetId: placement.assetId,
			sourceStartSec: placement.sourceStartSec,
			sourceEndSec: placement.sourceEndSec,
			timelineStartSec: 0,
			timelineEndSec: length,
			wordRefs: [],
			origin: "user",
			reason: "Media 조합",
			...(placement.cropRegion ? { cropRegion: placement.cropRegion } : {}),
		};
	});
	if (mode === "append") return withClipsChanged(document, [...document.timeline.clips, ...clips]);
	let next = pinAudioToProgramme(document);
	const subtitles = subtitlesOnProgramme(next);
	for (const clip of next.timeline.clips) next = removeClip(next, clip.id);
	return withSubtitlesBack(withClipsChanged(next, clips), subtitles);
}

/** The programme's clock for a document: raw ruler seconds, trims and speed taken out. */
function toProgrammeMs(document: AxcutDocument): (rawMs: number) => number {
	const { clips, trimRanges } = document.timeline;
	const regions = document.legacyEditor?.speedRegions;
	const speedRegions = Array.isArray(regions)
		? (regions as Array<{ startMs: number; endMs: number; speed: number }>)
		: [];
	return (rawMs) =>
		Math.round(
			projectRawTimelineSecToPlayback(clips, trimRanges, rawMs / 1000, speedRegions) * 1000,
		);
}

interface ProgrammeSubtitles {
	/** Every fragment of every subtitle, to take out wherever the clips left them. */
	ids: Set<string>;
	/** One region per subtitle, unanchored, at the programme time it showed at. */
	regions: AxcutAnnotationRegion[];
}

function subtitlesOnProgramme(document: AxcutDocument): ProgrammeSubtitles {
	const at = toProgrammeMs(document);
	const pills = coalesceRegionsForRuler(document.annotations.filter(isSubtitle));
	return {
		ids: new Set(pills.flatMap((pill) => pill.ids)),
		regions: pills.map((pill) => {
			const { clipId: _clip, sourceStartSec: _from, sourceEndSec: _to, ...payload } = pill.member;
			return {
				...payload,
				id: pill.ids[0],
				startMs: at(pill.start * 1000),
				endMs: at(pill.end * 1000),
			};
		}),
	};
}

/** The subtitles anchored again, to whatever clips now play at their times. */
function withSubtitlesBack(document: AxcutDocument, subtitles: ProgrammeSubtitles): AxcutDocument {
	if (subtitles.regions.length === 0) return document;
	const anchored = anchorRegionsWithDerivedMs(subtitles.regions, document.timeline.clips, () =>
		createId("subtitle"),
	) as AxcutAnnotationRegion[];
	return {
		...document,
		annotations: [
			...document.annotations.filter((region) => !subtitles.ids.has(region.id)),
			...anchored,
		],
	};
}

function pinAudioToProgramme(document: AxcutDocument): AxcutDocument {
	const programmeMs = toProgrammeMs(document);
	let next = document;
	for (const pill of collapseTracksToPills(document.audioTracks)) {
		if (pill.timelineLocked) continue;
		const startMs = programmeMs(pill.startMs);
		next = placeAudioTrackInDocument(
			next,
			{ ...pill, timelineLocked: true, startMs, endMs: startMs + (pill.endMs - pill.startMs) },
			() => createId("audio"),
			"move",
		);
	}
	return next;
}

let cancelRequested = false;

/** Stops an apply after the item it is rendering; nothing is placed. */
export function cancelApply(): void {
	cancelRequested = true;
}

/**
 * Renders what needs rendering and places the whole composition, as one undoable timeline
 * edit. Resolves null when nothing was placed: an empty composition, a cancel, or a project
 * switch or undo while it rendered.
 */
export async function applyComposition(
	mode: ApplyMode,
	onProgress: (progress: ApplyProgress) => void = () => undefined,
): Promise<ApplyResult | null> {
	const start = useProjectStore.getState();
	const projectId = start.projectId;
	const document = start.document;
	if (!projectId || !document) return null;
	const items = boardOf(document).items;
	if (items.length === 0) return null;
	cancelRequested = false;
	const epoch = currentWriteEpoch();
	const superseded = () =>
		cancelRequested ||
		useProjectStore.getState().projectId !== projectId ||
		currentWriteEpoch() !== epoch;

	const toRender = items.filter(itemNeedsRender).length;
	const target = { frame: projectOutputFrame(document), fit: getOutputSettings(document).mediaFit };
	let rendered = 0;
	let skipped = 0;
	const placements: Placement[] = [];
	for (const item of items) {
		if (superseded()) return null;
		const current = useProjectStore.getState().document ?? document;
		if (itemNeedsRender(item))
			onProgress({ done: rendered, total: toRender, label: item.label || "클립" });
		const placement = await placeItem(item, current, target, superseded);
		if (superseded()) return null;
		if (itemNeedsRender(item)) rendered++;
		if (placement) placements.push(placement);
		else skipped++;
	}
	onProgress({ done: rendered, total: toRender, label: "" });
	if (placements.length === 0) return { placed: 0, skipped };
	const saved = await enqueueDocumentWrite(async () => {
		if (superseded()) return false;
		const state = useProjectStore.getState();
		if (!state.document) return false;
		return state.saveDocument(fillFrame(placeOnTimeline(state.document, placements, mode)), {
			history: true,
		});
	});
	return saved ? { placed: placements.length, skipped } : null;
}

/**
 * Footage fills Edit's frame — no padding, corners or shadow — unless the user chose, in
 * Settings, to float the picture over the wallpaper.
 */
export function fillFrame(document: AxcutDocument): AxcutDocument {
	if (hasChosenFraming(document) && getFraming(document) === "floating") return document;
	return withFraming(document, "full");
}

/** What a render is made into: the frame, and — only when the shapes differ — how to fit it. */
function renderTarget(
	source: Frame,
	target: { frame: Frame; fit: MediaFit },
): { width: number; height: number; fit?: MediaFit } {
	return {
		width: target.frame.width,
		height: target.frame.height,
		...(sameShape(source, target.frame) ? {} : { fit: target.fit }),
	};
}

async function placeItem(
	item: AxcutMediaBoardItem,
	document: AxcutDocument,
	target: { frame: Frame; fit: MediaFit },
	superseded: () => boolean,
): Promise<Placement | null> {
	const effect = resolvedItemEffect(item);
	const durationSec = itemDurationSec(item);
	if (item.kind === "image") {
		const image = boardOf(document).images.find((entry) => entry.id === item.imageId);
		if (!image) return null;
		const result =
			effect === "none"
				? await convertImage(image, durationSec, target)
				: await renderEffect({
						sourcePath: image.path,
						sourceKind: "image",
						startMs: 0,
						endMs: Math.round(durationSec * 1000),
						effect,
						...renderTarget(await imageDimensions(image), target),
					});
		return mediaPlacement(
			result,
			`${item.label} · ${clipEffectLabel(effect)}`,
			durationSec,
			superseded,
		);
	}
	const asset = document.assets.find((entry) => entry.id === item.assetId);
	if (!asset) return null;
	if (effect === "none") {
		// Played from its source: a `cover` fit is a crop to the frame's shape.
		const cropRegion =
			target.fit === "cover" ? coverCrop(await videoDimensions(asset), target.frame) : undefined;
		return {
			assetId: asset.id,
			sourceStartSec: item.startSec,
			sourceEndSec: item.endSec,
			...(cropRegion ? { cropRegion } : {}),
		};
	}
	const result = await renderEffect({
		sourcePath: asset.originalPath,
		startMs: Math.round(item.startSec * 1000),
		endMs: Math.round(item.endSec * 1000),
		effect,
		...renderTarget(await videoDimensions(asset), target),
	});
	return mediaPlacement(
		result,
		`${item.label} · ${item.startSec.toFixed(1)}–${item.endSec.toFixed(1)}초 · ${clipEffectLabel(effect)}`,
		durationSec,
		superseded,
	);
}

async function renderEffect(request: CreateClipEffectRequest): Promise<CreateClipEffectResult> {
	const create = window.electronAPI?.createClipEffect;
	if (!create) throw new Error("효과 렌더링은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
	const result = await create(request);
	if (!result.success || !result.filePath)
		throw new Error(result.error || "효과를 적용한 클립을 만들지 못했습니다.");
	return result;
}

async function convertImage(
	image: AxcutMediaBoardImage,
	durationSec: number,
	target: { frame: Frame; fit: MediaFit },
): Promise<CreateClipEffectResult> {
	const create = window.electronAPI?.createImageClip;
	if (!create) throw new Error("사진 클립은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
	const result = await create(image.path, durationSec, {
		width: target.frame.width,
		height: target.frame.height,
		fit: target.fit,
	});
	if (!result.success || !result.filePath)
		throw new Error(result.error || `${image.label} 사진을 클립으로 만들지 못했습니다.`);
	return result;
}

async function videoDimensions(asset: AxcutAsset): Promise<{ width: number; height: number }> {
	if (asset.video?.width && asset.video.height)
		return { width: asset.video.width, height: asset.video.height };
	// Camera footage the browser cannot open still has a size FFmpeg can read.
	const probe = await window.electronAPI?.vclipProbe?.(asset.originalPath).catch(() => null);
	if (probe?.success && probe.width && probe.height)
		return { width: probe.width, height: probe.height };
	return { width: 1920, height: 1080 };
}

async function imageDimensions(
	image: AxcutMediaBoardImage,
): Promise<{ width: number; height: number }> {
	if (image.width && image.height) return { width: image.width, height: image.height };
	return (await readImageSize(toFileUrl(image.path))) ?? { width: 1920, height: 1080 };
}

/**
 * The rendered file as project media — the asset already pointing at it when there is one, so
 * applying twice does not list the same render twice — played whole.
 */
async function mediaPlacement(
	result: CreateClipEffectResult,
	label: string,
	expectedSec: number,
	superseded: () => boolean,
): Promise<Placement | null> {
	const filePath = result.filePath;
	if (!filePath || superseded()) return null;
	const durationSec = result.durationMs ? result.durationMs / 1000 : expectedSec;
	const existing = useProjectStore
		.getState()
		.document?.assets.find((asset) => samePath(asset.originalPath, filePath));
	if (existing)
		return {
			assetId: existing.id,
			sourceStartSec: 0,
			sourceEndSec: existing.durationSec || durationSec,
		};
	const created = await useProjectStore.getState().addAsset(filePath, label);
	if (!created || superseded()) return null;
	await enqueueDocumentWrite(async () => {
		if (superseded()) return false;
		const state = useProjectStore.getState();
		if (!state.document?.assets.some((asset) => asset.id === created.id)) return false;
		return state.saveDocument(
			{
				...state.document,
				assets: state.document.assets.map((asset) =>
					asset.id === created.id
						? {
								...asset,
								durationSec,
								video: {
									codec: "h264",
									fps: 30,
									width: result.width ?? asset.video?.width ?? 0,
									height: result.height ?? asset.video?.height ?? 0,
								},
							}
						: asset,
				),
			},
			{ history: false },
		);
	});
	return { assetId: created.id, sourceStartSec: 0, sourceEndSec: durationSec };
}
