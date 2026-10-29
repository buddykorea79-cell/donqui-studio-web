import type { WebClip } from "./project";
import { clipOutputToSourceTime } from "./timelineEffects";

export type RegionKind = "zoom" | "speed";
export type RegionSelection = { clipId: string; kind: RegionKind; id: string };

/** Find an unoccupied source interval at the playhead, bounded by the next region. */
export function newRegionRange(clip: WebClip, kind: RegionKind, outputTime: number) {
	const regions = kind === "zoom" ? (clip.zoomRegions ?? []) : (clip.speedRegions ?? []);
	const start = Math.max(
		0,
		Math.min(clip.duration - 0.1, clipOutputToSourceTime(clip, outputTime)),
	);
	const occupied = regions.find((region) => start >= region.start && start < region.end);
	if (occupied) return { existingId: occupied.id };
	const next = Math.min(
		clip.duration,
		...regions.filter((region) => region.start > start).map((region) => region.start),
	);
	return { start, end: Math.min(start + 2, next) };
}

/** Clamp an edited edge against neighbouring regions without silently deleting them. */
export function regionEdgeBounds(clip: WebClip, kind: RegionKind, id: string) {
	const regions = kind === "zoom" ? (clip.zoomRegions ?? []) : (clip.speedRegions ?? []);
	const region = regions.find((item) => item.id === id);
	if (!region) return { min: 0, max: clip.duration };
	return {
		min: Math.max(
			0,
			...regions
				.filter((item) => item.id !== id && item.end <= region.start)
				.map((item) => item.end),
		),
		max: Math.min(
			clip.duration,
			...regions
				.filter((item) => item.id !== id && item.start >= region.end)
				.map((item) => item.start),
		),
	};
}
