import { projectRawTimelineSecToPlayback } from "../ai-edition/document/timeline";
import type { AxcutDocument } from "../ai-edition/schema";

/** The audio bed uses programme time, so compare it to the trimmed, retimed picture. */
export function audioFitSummary(document: AxcutDocument) {
	const rawEnd = Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
	const regions = document.legacyEditor?.speedRegions;
	const speedRegions = Array.isArray(regions)
		? regions.filter(
				(region): region is { startMs: number; endMs: number; speed: number } =>
					region !== null &&
					typeof region === "object" &&
					Number.isFinite(region.startMs) &&
					Number.isFinite(region.endMs) &&
					Number.isFinite(region.speed) &&
					region.speed > 0,
			)
		: [];
	const pictureMs = Math.round(
		projectRawTimelineSecToPlayback(
			document.timeline.clips,
			document.timeline.trimRanges,
			rawEnd,
			speedRegions,
		) * 1000,
	);
	const audioMs = Math.max(
		0,
		...document.audioTracks.filter((track) => !track.muted).map((track) => track.endMs),
	);
	return { pictureMs, audioMs, remainingMs: Math.max(0, audioMs - pictureMs) };
}
