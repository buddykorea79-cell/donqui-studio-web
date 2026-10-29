import { VCLIP_SEGMENT_LIMITS, type VClipWindowAnalysis } from "./contract";

export interface VClipWindow {
	startSec: number;
	endSec: number;
}

/**
 * One range of a source video in V.Clip. It starts as an analysed window, a range added by
 * hand, or a clip already in Media's bin, and the user adjusts it from there: the range is
 * the segment's own, the analysis stays what it was.
 */
export interface VClipSegment {
	id: string;
	startSec: number;
	endSec: number;
	/** Waiting to be split into a clip: new, or changed since it was split. */
	selected: boolean;
	origin: "auto" | "manual" | "bin";
	/** The window it was found as; null for one added by hand or restored from the bin. */
	analysis: VClipWindowAnalysis | null;
	/** The bin clip it was split into. */
	clipId: string | null;
}

/** Shortest segment: below this a clip is a flicker. */
export const MIN_SEGMENT_SEC = 0.5;

/** Floors to centiseconds, so a window never ends past the source it was cut from. */
const floor2 = (value: number) => Math.floor(value * 100 + 1e-6) / 100;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function clampSegmentSec(value: number): number {
	if (!Number.isFinite(value)) return VCLIP_SEGMENT_LIMITS.defaultSec;
	return Math.min(VCLIP_SEGMENT_LIMITS.maxSec, Math.max(VCLIP_SEGMENT_LIMITS.minSec, value));
}

/**
 * AutoVeo's candidate windows: `segmentSec`-long windows spread evenly over the source (they
 * touch or barely overlap), thinned to `maxCount` that still include both ends of the footage.
 */
export function candidateWindows(
	durationSec: number,
	segmentSec: number,
	maxCount: number = VCLIP_SEGMENT_LIMITS.maxCandidates,
): VClipWindow[] {
	if (!Number.isFinite(durationSec) || durationSec <= 0 || maxCount < 1) return [];
	const length = clampSegmentSec(segmentSec);
	const end = floor2(durationSec);
	if (durationSec <= length) return [{ startSec: 0, endSec: end }];
	const count = Math.max(2, Math.ceil((durationSec - length) / length) + 1);
	const windows = Array.from({ length: count }, (_, index) => {
		const startSec = floor2(((durationSec - length) * index) / (count - 1));
		return { startSec, endSec: Math.min(end, floor2(startSec + length)) };
	});
	if (windows.length <= maxCount) return windows;
	if (maxCount === 1) return [windows[0]];
	return Array.from(
		{ length: maxCount },
		(_, index) => windows[Math.round((index * (windows.length - 1)) / (maxCount - 1))],
	);
}

export function segmentId(window: VClipWindow): string {
	return `${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}`;
}

/** The share of the shorter window that both cover. */
export function overlapRatio(left: VClipWindow, right: VClipWindow): number {
	const shared = Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec);
	const shortest = Math.min(left.endSec - left.startSec, right.endSec - right.startSec);
	return shared > 0 && shortest > 0 ? shared / shortest : 0;
}

/**
 * Best first: the score, then frame quality where the model scored alike, then the earlier
 * window.
 */
export function byMerit(left: VClipWindowAnalysis, right: VClipWindowAnalysis): number {
	return (
		right.score - left.score ||
		right.qualityScore - left.qualityScore ||
		left.startSec - right.startSec
	);
}

/** {@link byMerit} for segments; one added by hand has no score and goes last. */
export function bySegmentMerit(left: VClipSegment, right: VClipSegment): number {
	if (left.analysis && right.analysis) return byMerit(left.analysis, right.analysis);
	if (left.analysis) return -1;
	if (right.analysis) return 1;
	return left.startSec - right.startSec;
}

function fromAnalysis(analysis: VClipWindowAnalysis, selected: boolean): VClipSegment {
	return {
		id: segmentId(analysis),
		startSec: analysis.startSec,
		endSec: analysis.endSec,
		selected,
		origin: "auto",
		analysis,
		clipId: null,
	};
}

/** Windows as they arrive during a run: in source order, nothing selected yet. */
export function provisionalSegments(analyses: VClipWindowAnalysis[]): VClipSegment[] {
	return analyses
		.map((analysis) => fromAnalysis(analysis, false))
		.sort((left, right) => left.startSec - right.startSec);
}

/**
 * AutoVeo's choice: best first ({@link byMerit}), a window overlapping a better one by more
 * than 40 % of the shorter is dropped, and the top `preselect` start out selected. Returned in
 * source order.
 */
export function rankSegments(
	analyses: VClipWindowAnalysis[],
	options: { maxKeep?: number; preselect?: number } = {},
): VClipSegment[] {
	const maxKeep = options.maxKeep ?? VCLIP_SEGMENT_LIMITS.maxKeep;
	const preselect = options.preselect ?? VCLIP_SEGMENT_LIMITS.preselect;
	const chosen: VClipWindowAnalysis[] = [];
	for (const analysis of [...analyses].sort(byMerit)) {
		if (chosen.length >= maxKeep) break;
		if (chosen.some((other) => overlapRatio(other, analysis) > 0.4)) continue;
		chosen.push(analysis);
	}
	const best = new Set(chosen.slice(0, preselect));
	return chosen
		.map((analysis) => fromAnalysis(analysis, best.has(analysis)))
		.sort((left, right) => left.startSec - right.startSec);
}

/**
 * A finished analysis joined to the segments the user already has. Segments added by hand or
 * split into clips stay as they are; a found window with the exact range of one of them lends
 * it its analysis, and one overlapping them by more than 40 % is dropped as a near-duplicate.
 * A source that had none gets the best three preselected, as AutoVeo does.
 */
export function mergeAnalysis(
	kept: VClipSegment[],
	analyses: VClipWindowAnalysis[],
): VClipSegment[] {
	const fresh = rankSegments(analyses, { preselect: kept.length === 0 ? undefined : 0 });
	const merged = kept.map((segment) => {
		const same = fresh.find(
			(found) =>
				Math.abs(found.startSec - segment.startSec) < 0.01 &&
				Math.abs(found.endSec - segment.endSec) < 0.01,
		);
		return same && !segment.analysis ? { ...segment, analysis: same.analysis } : segment;
	});
	for (const found of fresh) {
		if (kept.some((segment) => overlapRatio(segment, found) > 0.4)) continue;
		merged.push(found);
	}
	return merged.sort((left, right) => left.startSec - right.startSec);
}

export function selectedDurationSec(segments: VClipSegment[]): number {
	return segments
		.filter((segment) => segment.selected)
		.reduce((sum, segment) => sum + segment.endSec - segment.startSec, 0);
}

/**
 * Best-scored segments until they cover `targetSec` — the audio still without a clip. Every
 * segment when even all of them fall short.
 */
export function selectionToFill(segments: VClipSegment[], targetSec: number): Set<string> {
	const picked = new Set<string>();
	let total = 0;
	for (const segment of [...segments].sort(bySegmentMerit)) {
		if (total >= targetSec) break;
		picked.add(segment.id);
		total += segment.endSec - segment.startSec;
	}
	return picked;
}

/**
 * A segment's range after the user moved it: inside the source, at least
 * {@link MIN_SEGMENT_SEC} long, to the centisecond. Moving the start past the end (or the end
 * before the start) drags the other edge along rather than refusing.
 */
export function clampSegmentRange(
	range: VClipWindow,
	durationSec: number | undefined,
	moved: "start" | "end" | "both" = "both",
): VClipWindow {
	const limit = durationSec && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
	const minimum = Math.min(MIN_SEGMENT_SEC, limit);
	let startSec = Math.max(0, Number.isFinite(range.startSec) ? range.startSec : 0);
	let endSec = Math.min(limit, Number.isFinite(range.endSec) ? range.endSec : startSec + minimum);
	if (endSec - startSec < minimum) {
		if (moved === "end") startSec = Math.max(0, endSec - minimum);
		else endSec = Math.min(limit, startSec + minimum);
		if (endSec - startSec < minimum) startSec = Math.max(0, endSec - minimum);
	}
	return { startSec: round2(startSec), endSec: Math.min(limit, round2(endSec)) };
}

/**
 * Where a segment added by hand goes: after the last one there is (AutoVeo's "아직 쓰지 않은
 * 자리부터"), `lengthSec` long, pulled back when that would run past the end.
 */
export function nextManualRange(
	segments: VClipWindow[],
	durationSec: number,
	lengthSec: number,
): VClipWindow {
	const length = Math.min(Math.max(MIN_SEGMENT_SEC, lengthSec), durationSec);
	const lastEnd = segments.reduce((end, segment) => Math.max(end, segment.endSec), 0);
	const startSec = Math.max(0, Math.min(lastEnd, durationSec - length));
	return {
		startSec: round2(startSec),
		endSec: Math.min(floor2(durationSec), round2(startSec + length)),
	};
}
