import { CLIP_EFFECT_FPS } from "../lib/clip-effects/catalog";
import type { WebAsset, WebClip, WebProject } from "./project";
import type { RegionKind, RegionSelection } from "./regionEditing";
import {
	clipOutputToSourceTime,
	clipSourceToOutputTime,
	getClipOutputDuration,
	splitClipAtOutputTime,
	type WebSpeedRegion,
	type WebZoomRegion,
} from "./timelineEffects";

export type TimelineRange = { start: number; end: number };
export type TimelineClipSpan = { clip: WebClip; start: number; end: number };

const MIN_OUTPUT_DURATION = 1 / CLIP_EFFECT_FPS;
const MAX_SOURCE_DURATION = 86_400;
const EPSILON = 1e-7;

export function getTimelineClips(project: WebProject): TimelineClipSpan[] {
	let start = 0;
	return project.clips.map((clip) => {
		const span = { clip, start, end: start + getClipOutputDuration(clip) };
		start = span.end;
		return span;
	});
}

export function normalizeTimelineRange(
	range: TimelineRange,
	duration: number,
): TimelineRange | null {
	if (![range.start, range.end, duration].every(Number.isFinite) || duration <= 0) return null;
	const start = Math.max(0, Math.min(duration, Math.min(range.start, range.end)));
	const end = Math.max(0, Math.min(duration, Math.max(range.start, range.end)));
	return end - start >= Math.min(MIN_OUTPUT_DURATION, duration) - EPSILON ? { start, end } : null;
}

/** Keep a fragment using output-time cuts, including any partially completed zoom ramps. */
function sliceClip(
	clip: WebClip,
	start: number,
	end: number,
	id: string,
	isImage: boolean,
): WebClip {
	let result = clip;
	if (end < getClipOutputDuration(clip) - EPSILON) {
		[result] = splitClipAtOutputTime(result, end, crypto.randomUUID(), isImage);
	}
	if (start > EPSILON) {
		[, result] = splitClipAtOutputTime(result, start, id, isImage);
	}
	return result.id === id ? result : { ...result, id };
}

/** Ripple only the visual track. Music and absolute-time captions retain their positions. */
export function deleteTimelineRange(
	project: WebProject,
	range: TimelineRange,
	assets: WebAsset[] = [],
): WebProject {
	const spans = getTimelineClips(project);
	const selection = normalizeTimelineRange(range, spans[spans.length - 1]?.end ?? 0);
	if (!selection) return project;
	const imageIds = new Set(
		assets.filter((asset) => asset.kind === "image").map((asset) => asset.id),
	);
	const clips = spans.flatMap(({ clip, start, end }) => {
		if (end <= selection.start || start >= selection.end) return [clip];
		const localStart = Math.max(0, selection.start - start);
		const localEnd = Math.min(end - start, selection.end - start);
		const fragments: WebClip[] = [];
		const isImage = imageIds.has(clip.assetId);
		if (localStart > EPSILON) fragments.push(sliceClip(clip, 0, localStart, clip.id, isImage));
		if (localEnd < end - start - EPSILON) {
			fragments.push(
				sliceClip(
					clip,
					localEnd,
					end - start,
					fragments.length ? crypto.randomUUID() : clip.id,
					isImage,
				),
			);
		}
		return fragments;
	});
	return { ...project, clips, updatedAt: new Date().toISOString() };
}

/** Positive deltas move the chosen edge later in the original output timeline. */
export function resizeClipEdge(
	clip: WebClip,
	asset: WebAsset,
	edge: "start" | "end",
	deltaOutput: number,
): WebClip {
	if (!Number.isFinite(deltaOutput) || Math.abs(deltaOutput) < EPSILON) return clip;
	if (asset.id !== clip.assetId || asset.kind === "audio") {
		throw new Error("클립의 원본 영상이나 사진을 찾을 수 없습니다.");
	}
	const duration = getClipOutputDuration(clip);
	const minimum = Math.min(MIN_OUTPUT_DURATION, duration);
	const isImage = asset.kind === "image";
	if (edge === "start" && deltaOutput > 0) {
		const amount = Math.min(deltaOutput, duration - minimum);
		return amount > EPSILON ? sliceClip(clip, amount, duration, clip.id, isImage) : clip;
	}
	if (edge === "end" && deltaOutput < 0) {
		const end = Math.max(minimum, duration + deltaOutput);
		return end < duration - EPSILON ? sliceClip(clip, 0, end, clip.id, isImage) : clip;
	}
	// Newly exposed source material is deliberately normal speed; saved regions move with it.
	const available = isImage
		? MAX_SOURCE_DURATION - clip.duration
		: edge === "start"
			? clip.trimStart
			: asset.duration - clip.trimStart - clip.duration;
	const amount = Math.max(
		0,
		Math.min(Math.abs(deltaOutput), available, MAX_SOURCE_DURATION - clip.duration),
	);
	if (amount < EPSILON) return clip;
	if (edge === "end") return { ...clip, duration: clip.duration + amount };
	return {
		...clip,
		trimStart: isImage ? 0 : Math.max(0, clip.trimStart - amount),
		duration: clip.duration + amount,
		...(clip.speedRegions && {
			speedRegions: clip.speedRegions.map((region) => ({
				...region,
				start: region.start + amount,
				end: region.end + amount,
			})),
		}),
		...(clip.zoomRegions && {
			zoomRegions: clip.zoomRegions.map((region) => ({
				...region,
				start: region.start + amount,
				end: region.end + amount,
			})),
		}),
	};
}

function outsideSpeedFragments(regions: WebSpeedRegion[], start: number, end: number) {
	return regions.flatMap((region) => {
		if (region.end <= start || region.start >= end) return [region];
		const fragments: WebSpeedRegion[] = [];
		if (region.start < start) fragments.push({ ...region, end: start });
		if (region.end > end)
			fragments.push({
				...region,
				start: end,
				id: fragments.length ? crypto.randomUUID() : region.id,
			});
		return fragments;
	});
}

function outsideZoomFragments(clip: WebClip, start: number, end: number) {
	return (clip.zoomRegions ?? []).flatMap((region) => {
		if (region.end <= start || region.start >= end) return [region];
		const outputStart = clipSourceToOutputTime(clip, region.start);
		const outputEnd = clipSourceToOutputTime(clip, region.end);
		const ramp = Math.min(0.25, (outputEnd - outputStart) / 2);
		const phases = {
			easeInDuration: region.easeInDuration ?? ramp,
			easeOutDuration: region.easeOutDuration ?? ramp,
			easeInOffset: region.easeInOffset ?? 0,
			easeOutOffset: region.easeOutOffset ?? 0,
		};
		const fragments: WebZoomRegion[] = [];
		if (region.start < start)
			fragments.push({
				...region,
				...phases,
				end: start,
				easeOutOffset: phases.easeOutOffset + outputEnd - clipSourceToOutputTime(clip, start),
			});
		if (region.end > end)
			fragments.push({
				...region,
				...phases,
				id: fragments.length ? crypto.randomUUID() : region.id,
				start: end,
				easeInOffset: phases.easeInOffset + clipSourceToOutputTime(clip, end) - outputStart,
			});
		return fragments;
	});
}

/** Replace the selected source spans, preserving effects outside the selection. */
export function applyTimelineRegion(
	project: WebProject,
	kind: RegionKind,
	range: TimelineRange,
): { project: WebProject; selection: RegionSelection | null } {
	const spans = getTimelineClips(project);
	const rangeToApply = normalizeTimelineRange(range, spans[spans.length - 1]?.end ?? 0);
	if (!rangeToApply) return { project, selection: null };
	let selection: RegionSelection | null = null;
	const clips = spans.map(({ clip, start, end }) => {
		if (end <= rangeToApply.start || start >= rangeToApply.end) return clip;
		const sourceStart = clipOutputToSourceTime(clip, Math.max(0, rangeToApply.start - start));
		const sourceEnd = clipOutputToSourceTime(clip, Math.min(end - start, rangeToApply.end - start));
		if (sourceEnd - sourceStart < EPSILON) return clip;
		const id = crypto.randomUUID();
		selection ??= { clipId: clip.id, kind, id };
		const base = { id, start: sourceStart, end: sourceEnd };
		if (kind === "zoom") {
			return {
				...clip,
				zoomRegions: [
					...outsideZoomFragments(clip, sourceStart, sourceEnd),
					{ ...base, scale: 2, focusX: 0.5, focusY: 0.5 },
				].sort((a, b) => a.start - b.start),
			};
		}
		return {
			...clip,
			speedRegions: [
				...outsideSpeedFragments(clip.speedRegions ?? [], sourceStart, sourceEnd),
				{ ...base, rate: 2 },
			].sort((a, b) => a.start - b.start),
		};
	});
	return {
		project: { ...project, clips, updatedAt: new Date().toISOString() },
		selection,
	};
}
