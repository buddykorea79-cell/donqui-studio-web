import type { WebClip } from "./project";

/** Times are relative to the clip's trimmed source, before playback speed is applied. */
export type WebZoomRegion = {
	id: string;
	start: number;
	end: number;
	scale: number;
	focusX: number;
	focusY: number;
	/** Output-second transition phases retained when a clip splits through a zoom. */
	easeInDuration?: number;
	easeOutDuration?: number;
	easeInOffset?: number;
	easeOutOffset?: number;
};

export type WebSpeedRegion = {
	id: string;
	start: number;
	end: number;
	rate: number;
};

export type ClipTimingSegment = {
	sourceStart: number;
	sourceEnd: number;
	outputStart: number;
	outputEnd: number;
	rate: number;
};

/** Build a continuous piecewise mapping; uncovered source ranges play at normal speed. */
export function getClipTiming(clip: WebClip): ClipTimingSegment[] {
	const segments: ClipTimingSegment[] = [];
	let sourceStart = 0;
	let outputStart = 0;
	const append = (sourceEnd: number, rate: number) => {
		if (sourceEnd <= sourceStart) return;
		const outputEnd = outputStart + (sourceEnd - sourceStart) / rate;
		segments.push({ sourceStart, sourceEnd, outputStart, outputEnd, rate });
		sourceStart = sourceEnd;
		outputStart = outputEnd;
	};
	for (const region of [...(clip.speedRegions ?? [])].sort((a, b) => a.start - b.start)) {
		append(Math.min(clip.duration, region.start), 1);
		append(Math.min(clip.duration, region.end), region.rate);
	}
	append(clip.duration, 1);
	return segments;
}

export function getClipOutputDuration(clip: WebClip): number {
	const segments = getClipTiming(clip);
	return segments[segments.length - 1]?.outputEnd ?? 0;
}

export function clipOutputToSourceTime(clip: WebClip, time: number): number {
	const segments = getClipTiming(clip);
	const bounded = Math.max(0, Math.min(time, segments[segments.length - 1]?.outputEnd ?? 0));
	const segment =
		segments.find((item) => bounded < item.outputEnd) ?? segments[segments.length - 1];
	return segment
		? Math.min(clip.duration, segment.sourceStart + (bounded - segment.outputStart) * segment.rate)
		: 0;
}

export function clipSourceToOutputTime(clip: WebClip, time: number): number {
	const bounded = Math.max(0, Math.min(time, clip.duration));
	const segments = getClipTiming(clip);
	const segment =
		segments.find((item) => bounded < item.sourceEnd) ?? segments[segments.length - 1];
	return segment ? segment.outputStart + (bounded - segment.sourceStart) / segment.rate : 0;
}

export function clipPlaybackRateAt(clip: WebClip, outputTime: number): number {
	const segments = getClipTiming(clip);
	return (
		segments.find((item) => Math.max(0, outputTime) < item.outputEnd)?.rate ??
		segments[segments.length - 1]?.rate ??
		1
	);
}

type Region = WebZoomRegion | WebSpeedRegion;

function sliceRegions<T extends Region>(regions: T[], start: number, end: number): T[] {
	return regions
		.filter((region) => region.start < end && region.end > start)
		.map((region) => ({
			...region,
			start: Math.max(start, region.start) - start,
			end: Math.min(end, region.end) - start,
		}));
}

function zoomTiming(clip: WebClip, region: WebZoomRegion) {
	const start = clipSourceToOutputTime(clip, region.start);
	const end = clipSourceToOutputTime(clip, region.end);
	const ramp = Math.min(0.25, (end - start) / 2);
	return {
		start,
		end,
		easeInDuration: region.easeInDuration ?? ramp,
		easeOutDuration: region.easeOutDuration ?? ramp,
		easeInOffset: region.easeInOffset ?? 0,
		easeOutOffset: region.easeOutOffset ?? 0,
	};
}

/** Keep saved ranges valid after shortening a clip; absent fields stay absent for old projects. */
export function normalizeClipRegions(clip: WebClip): WebClip {
	return {
		...clip,
		...(clip.zoomRegions && { zoomRegions: sliceRegions(clip.zoomRegions, 0, clip.duration) }),
		...(clip.speedRegions && { speedRegions: sliceRegions(clip.speedRegions, 0, clip.duration) }),
	};
}

/** Split on the output playhead while retaining the correct source trim and region placement. */
export function splitClipAtOutputTime(
	clip: WebClip,
	outputTime: number,
	secondId: string,
	isImage = false,
): [WebClip, WebClip] {
	const sourceTime = clipOutputToSourceTime(clip, outputTime);
	if (sourceTime <= 0 || sourceTime >= clip.duration) {
		throw new Error("선택한 클립 안쪽에서 나눠 주세요.");
	}
	const left = normalizeClipRegions({ ...clip, duration: sourceTime });
	if (left.zoomRegions) {
		left.zoomRegions = left.zoomRegions.map((region) => {
			const original = clip.zoomRegions?.find((item) => item.id === region.id);
			if (!original || original.start >= sourceTime || original.end <= sourceTime) return region;
			const timing = zoomTiming(clip, original);
			return {
				...region,
				easeInDuration: timing.easeInDuration,
				easeOutDuration: timing.easeOutDuration,
				easeInOffset: timing.easeInOffset,
				easeOutOffset: timing.easeOutOffset + timing.end - outputTime,
			};
		});
	}
	return [
		left,
		{
			...clip,
			id: secondId,
			trimStart: isImage ? 0 : clip.trimStart + sourceTime,
			duration: clip.duration - sourceTime,
			...(clip.zoomRegions && {
				zoomRegions: sliceRegions(clip.zoomRegions, sourceTime, clip.duration).map((region) => {
					const original = clip.zoomRegions?.find((item) => item.id === region.id);
					const next = { ...region, id: crypto.randomUUID() };
					if (!original || original.start >= sourceTime || original.end <= sourceTime) return next;
					const timing = zoomTiming(clip, original);
					return {
						...next,
						easeInDuration: timing.easeInDuration,
						easeOutDuration: timing.easeOutDuration,
						easeInOffset: timing.easeInOffset + outputTime - timing.start,
						easeOutOffset: timing.easeOutOffset,
					};
				}),
			}),
			...(clip.speedRegions && {
				speedRegions: sliceRegions(clip.speedRegions, sourceTime, clip.duration).map((region) => ({
					...region,
					id: crypto.randomUUID(),
				})),
			}),
		},
	];
}

const smoothstep = (value: number) => value * value * (3 - 2 * value);

/** Zoom eases over output time so fast/slow source regions do not change its transition speed. */
export function getZoomTransform(clip: WebClip, outputTime: number) {
	const sourceTime = clipOutputToSourceTime(clip, outputTime);
	const region = clip.zoomRegions?.find(
		(item) => sourceTime >= item.start && sourceTime < item.end,
	);
	if (!region) return { scale: 1, focusX: 0.5, focusY: 0.5 };
	const timing = zoomTiming(clip, region);
	const envelope = Math.max(
		0,
		Math.min(
			1,
			(outputTime - timing.start + timing.easeInOffset) / timing.easeInDuration,
			(timing.end - outputTime + timing.easeOutOffset) / timing.easeOutDuration,
		),
	);
	return {
		scale: 1 + (region.scale - 1) * smoothstep(envelope),
		focusX: region.focusX,
		focusY: region.focusY,
	};
}
