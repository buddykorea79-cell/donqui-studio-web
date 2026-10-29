import { collapseTracksToPills } from "@/lib/ai-edition/document/audioTracks";
import type { AxcutDocument, AxcutMediaBoardItem } from "@/lib/ai-edition/schema";
import { findAssetTranscript } from "@/lib/ai-edition/transcription/status";
import { itemDurationSec, MAX_IMAGE_SEC, MIN_ITEM_SEC } from "./board";

/**
 * Fitting the composition to the Audio tab's soundtrack: the items stretch or shrink together
 * until they end with the audio, and, when the narration has a transcript, the cuts between
 * them move onto the pauses in the speech — AutoVeo's "말이 끊기는 곳" rule.
 *
 * Everything is computed in whole frames at the clip-effect rate, so a fitted composition
 * ends on the audio's last frame instead of a rounding error away from it.
 */

export const FIT_FPS = 30;

export interface FitSlot {
	durationSec: number;
	minSec: number;
	maxSec: number;
}

export interface FitResult {
	durations: number[];
	/** Audio the items cannot cover even at their longest. */
	shortSec: number;
	/** How far the items overrun the audio even at their shortest. */
	overSec: number;
}

const toFrames = (sec: number) => Math.round(sec * FIT_FPS);
const toSec = (frames: number) => frames / FIT_FPS;

/** The stretch of its source a clip or video may occupy, in source seconds. */
export interface SourceWindow {
	lo: number;
	hi: number;
}

/** All of the source; just the item's own range when the source's length is unknown. */
function wholeSource(
	item: AxcutMediaBoardItem,
	sourceDurationSec: number | undefined,
): SourceWindow {
	return sourceDurationSec && sourceDurationSec > 0
		? { lo: 0, hi: Math.max(item.endSec, sourceDurationSec) }
		: { lo: item.startSec, hi: item.endSec };
}

/** Two items of one source where one lies inside the other: the same footage, on purpose. */
function nested(left: AxcutMediaBoardItem, right: AxcutMediaBoardItem): boolean {
	return (
		(left.startSec <= right.startSec && left.endSec >= right.endSec) ||
		(right.startSec <= left.startSec && right.endSec >= left.endSec)
	);
}

/** The other clips and videos that show footage of the same source as `item`. */
function sameSource(
	item: AxcutMediaBoardItem,
	items: AxcutMediaBoardItem[],
): AxcutMediaBoardItem[] {
	if (item.kind === "image") return [];
	return items.filter(
		(other) => other.id !== item.id && other.kind !== "image" && other.assetId === item.assetId,
	);
}

/**
 * The part of its source an item can grow into without showing footage another item of the same
 * source shows: each gap between two neighbours is shared at its middle, and a neighbour that
 * already overlaps one end — V.Clip's own segments do, a little — stops it growing past that end.
 * One item inside another was doubled on purpose and does not count.
 */
export function freeWindow(
	item: AxcutMediaBoardItem,
	items: AxcutMediaBoardItem[],
	sourceDurationSec: number | undefined,
): SourceWindow {
	let { lo, hi } = wholeSource(item, sourceDurationSec);
	for (const other of sameSource(item, items)) {
		if (nested(item, other)) continue;
		if (other.endSec <= item.startSec) lo = Math.max(lo, (other.endSec + item.startSec) / 2);
		else if (other.startSec >= item.endSec) hi = Math.min(hi, (item.endSec + other.startSec) / 2);
		else if (other.startSec < item.startSec) lo = Math.max(lo, item.startSec);
		else hi = Math.min(hi, item.endSec);
	}
	return { lo: Math.min(lo, item.startSec), hi: Math.max(hi, item.endSec) };
}

/**
 * How far an item can stretch. A photo holds for as long as it is asked to; a clip or a whole
 * video can grow into its window of the source — past its end first, then back before its start.
 * Without a window it may use the whole source; with the source's length unknown, it cannot grow.
 */
export function itemFitSlot(
	item: AxcutMediaBoardItem,
	sourceDurationSec: number | undefined,
	window?: SourceWindow,
): FitSlot {
	const durationSec = itemDurationSec(item);
	if (item.kind === "image") return { durationSec, minSec: MIN_ITEM_SEC, maxSec: MAX_IMAGE_SEC };
	const room = window ?? wholeSource(item, sourceDurationSec);
	return {
		durationSec,
		minSec: Math.min(MIN_ITEM_SEC, durationSec),
		maxSec: Math.max(durationSec, room.hi - room.lo),
	};
}

/**
 * Stretches or shrinks the slots together until they add up to `targetSec`, each in proportion
 * to its own length and within its own bounds: the ones that hit a bound stop there and the
 * rest take up the difference (water-filling). Whole frames; they sum to the target exactly
 * whenever the bounds allow it.
 */
export function fitDurations(slots: FitSlot[], targetSec: number): FitResult {
	if (slots.length === 0 || !Number.isFinite(targetSec) || targetSec <= 0)
		return { durations: slots.map((slot) => slot.durationSec), shortSec: 0, overSec: 0 };
	const target = toFrames(targetSec);
	const lengths = slots.map((slot) => Math.max(1e-6, slot.durationSec * FIT_FPS));
	const mins = slots.map((slot) => Math.max(1, Math.ceil(slot.minSec * FIT_FPS - 1e-6)));
	const maxs = slots.map((slot, index) =>
		Math.max(mins[index], Math.floor(slot.maxSec * FIT_FPS + 1e-6)),
	);
	const sumMin = mins.reduce((sum, value) => sum + value, 0);
	const sumMax = maxs.reduce((sum, value) => sum + value, 0);
	if (sumMin >= target)
		return { durations: mins.map(toSec), shortSec: 0, overSec: toSec(sumMin - target) };
	if (sumMax <= target)
		return { durations: maxs.map(toSec), shortSec: toSec(target - sumMax), overSec: 0 };

	const stretched = (scale: number) =>
		lengths.map((length, index) => Math.min(maxs[index], Math.max(mins[index], length * scale)));
	const total = (scale: number) => stretched(scale).reduce((sum, value) => sum + value, 0);
	let low = 0;
	let high = Math.max(...maxs.map((max, index) => max / lengths[index]));
	for (let step = 0; step < 80; step++) {
		const middle = (low + high) / 2;
		if (total(middle) < target) low = middle;
		else high = middle;
	}
	const exact = stretched(high);
	const frames = exact.map((value, index) =>
		Math.min(maxs[index], Math.max(mins[index], Math.floor(value + 1e-9))),
	);
	// Hand the frames lost to rounding to the slots that lost the most, while they have room.
	let residual = target - frames.reduce((sum, value) => sum + value, 0);
	const byLoss = exact
		.map((value, index) => ({ index, loss: value - frames[index] }))
		.sort((left, right) => right.loss - left.loss);
	while (residual > 0) {
		const next = byLoss.find(({ index }) => frames[index] < maxs[index]);
		if (!next) break;
		frames[next.index]++;
		residual--;
		next.loss = -1;
		byLoss.sort((left, right) => right.loss - left.loss);
	}
	while (residual < 0) {
		const next = [...byLoss].reverse().find(({ index }) => frames[index] > mins[index]);
		if (!next) break;
		frames[next.index]--;
		residual++;
	}
	return { durations: frames.map(toSec), shortSec: 0, overSec: 0 };
}

/**
 * Moves each cut between two items onto the nearest pause within `toleranceSec` of it — only
 * where the items on both sides, and all the ones after, can still keep to their bounds. The
 * total never changes; a cut with no usable pause nearby stays where the fit put it.
 */
export function snapCutsToPauses(
	durations: number[],
	slots: FitSlot[],
	pausesSec: number[],
	toleranceSec = 1,
): number[] {
	if (durations.length < 2 || pausesSec.length === 0) return durations;
	const lengths = durations.map(toFrames);
	const mins = slots.map((slot) => Math.max(1, Math.ceil(slot.minSec * FIT_FPS - 1e-6)));
	const maxs = slots.map((slot, index) =>
		Math.max(mins[index], lengths[index], Math.floor(slot.maxSec * FIT_FPS + 1e-6)),
	);
	const end = lengths.reduce((sum, value) => sum + value, 0);
	const pauses = pausesSec.map(toFrames).sort((left, right) => left - right);
	const tolerance = toFrames(toleranceSec);
	const suffixMin = (from: number) => mins.slice(from).reduce((sum, value) => sum + value, 0);
	const suffixMax = (from: number) => maxs.slice(from).reduce((sum, value) => sum + value, 0);
	const result: number[] = [];
	let previous = 0;
	let planned = 0;
	for (let index = 0; index < lengths.length - 1; index++) {
		planned += lengths[index];
		const low = Math.max(previous + mins[index], end - suffixMax(index + 1));
		const high = Math.min(previous + maxs[index], end - suffixMin(index + 1));
		if (low > high) return durations;
		let cut = Math.min(high, Math.max(low, planned));
		let best = Number.POSITIVE_INFINITY;
		for (const pause of pauses) {
			const distance = Math.abs(pause - planned);
			if (distance <= tolerance && pause >= low && pause <= high && distance < best) {
				best = distance;
				cut = pause;
			}
		}
		result.push(cut - previous);
		previous = cut;
	}
	result.push(end - previous);
	return result.map(toSec);
}

export interface Span {
	startSec: number;
	endSec: number;
}

export interface NarrationSpeech {
	/** Where the voiceover track plays, in programme seconds. */
	track: Span;
	/** Its words (or speech segments, for a transcript without words), in programme seconds. */
	spoken: Span[];
}

/**
 * What each narration says when, in programme seconds: voiceover tracks with a transcript,
 * their words mapped from the file onto where the track plays. Music has no words.
 */
export function narrationSpeech(document: AxcutDocument): NarrationSpeech[] {
	const result: NarrationSpeech[] = [];
	for (const track of collapseTracksToPills(document.audioTracks)) {
		if (track.kind !== "voiceover" || track.muted) continue;
		const transcript = findAssetTranscript(document, track.assetId);
		if (!transcript) continue;
		const offset = track.offsetMs / 1000;
		const start = track.startMs / 1000;
		const end = track.endMs / 1000;
		const toProgramme = (sec: number) => start + (sec - offset);
		const speech: Span[] =
			transcript.words.length > 0
				? transcript.words.filter((word) => word.text.trim().length > 0)
				: transcript.segments.filter((segment) => segment.kind === "speech");
		const spoken = speech
			.map((part) => ({
				startSec: Math.max(start, toProgramme(part.startSec)),
				endSec: Math.min(end, toProgramme(part.endSec)),
			}))
			.filter((part) => part.endSec > part.startSec)
			.sort((left, right) => left.startSec - right.startSec);
		if (spoken.length > 0) result.push({ track: { startSec: start, endSec: end }, spoken });
	}
	return result;
}

/**
 * Where the narration pauses, in programme seconds: between two words at least `minGapSec`
 * apart, and just before its first word and after its last.
 */
export function narrationPauses(document: AxcutDocument, minGapSec = 0.25): number[] {
	const pauses: number[] = [];
	for (const { track, spoken } of narrationSpeech(document)) {
		const lead = Math.max(track.startSec, spoken[0].startSec - 0.15);
		if (lead > track.startSec) pauses.push(lead);
		for (let index = 1; index < spoken.length; index++) {
			const gap = spoken[index].startSec - spoken[index - 1].endSec;
			if (gap >= minGapSec) pauses.push((spoken[index - 1].endSec + spoken[index].startSec) / 2);
		}
		const tail = Math.min(track.endSec, spoken[spoken.length - 1].endSec + 0.15);
		if (tail < track.endSec) pauses.push(tail);
	}
	return pauses.sort((left, right) => left - right);
}

/**
 * The item at a new length. A photo simply lasts that long. A clip keeps its start and moves
 * its end; past the end of its window of the source it moves its start back instead.
 */
export function itemWithDuration(
	item: AxcutMediaBoardItem,
	durationSec: number,
	sourceDurationSec: number | undefined,
	window?: SourceWindow,
): { startSec: number; endSec: number } {
	if (item.kind === "image") return { startSec: 0, endSec: durationSec };
	const room = window ?? wholeSource(item, sourceDurationSec);
	let startSec = Math.max(room.lo, item.startSec);
	if (startSec + durationSec > room.hi) startSec = Math.max(room.lo, room.hi - durationSec);
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return { startSec: round(startSec), endSec: round(startSec + durationSec) };
}

export interface CompositionFit {
	ranges: Map<string, { startSec: number; endSec: number }>;
	shortSec: number;
	overSec: number;
	snapped: boolean;
	/** Some clip now shows footage another clip of the same source shows too. */
	reused: boolean;
}

/**
 * The whole fit: every item's new range for a composition that ends with the audio, and, when
 * asked, cuts on the narration's pauses. Clips grow into footage no other item shows first;
 * only when that falls short of the audio do they grow into each other's footage.
 */
export function fitComposition(
	items: AxcutMediaBoardItem[],
	targetSec: number,
	sourceDurations: (item: AxcutMediaBoardItem) => number | undefined,
	options: { pausesSec?: number[]; toleranceSec?: number } = {},
): CompositionFit {
	let windows: Array<SourceWindow | undefined> = items.map((item) =>
		item.kind === "image" ? undefined : freeWindow(item, items, sourceDurations(item)),
	);
	let slots = items.map((item, index) => itemFitSlot(item, sourceDurations(item), windows[index]));
	let fitted = fitDurations(slots, targetSec);
	if (fitted.shortSec > 0) {
		const loose = items.map((item) => itemFitSlot(item, sourceDurations(item)));
		const retry = fitDurations(loose, targetSec);
		if (retry.shortSec < fitted.shortSec) {
			windows = items.map(() => undefined);
			slots = loose;
			fitted = retry;
		}
	}
	const pauses = options.pausesSec ?? [];
	const durations =
		pauses.length > 0 && fitted.shortSec === 0 && fitted.overSec === 0
			? snapCutsToPauses(fitted.durations, slots, pauses, options.toleranceSec)
			: fitted.durations;
	const ranges = new Map(
		items.map((item, index) => [
			item.id,
			itemWithDuration(item, durations[index], sourceDurations(item), windows[index]),
		]),
	);
	return {
		ranges,
		shortSec: fitted.shortSec,
		overSec: fitted.overSec,
		snapped: durations.some(
			(duration, index) => Math.abs(duration - fitted.durations[index]) > 0.5 / FIT_FPS,
		),
		reused: sharesMoreFootage(items, ranges),
	};
}

/**
 * Whether the fit made two items of one source show more of the same footage than before —
 * leaving alone the ones doubled on purpose. A few milliseconds of rounding do not count.
 */
function sharesMoreFootage(
	items: AxcutMediaBoardItem[],
	ranges: Map<string, { startSec: number; endSec: number }>,
): boolean {
	const shared = (left: Span, right: Span) =>
		Math.max(0, Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec));
	return items.some((item) =>
		sameSource(item, items).some((other) => {
			if (nested(item, other)) return false;
			const left = ranges.get(item.id);
			const right = ranges.get(other.id);
			return (
				left !== undefined &&
				right !== undefined &&
				shared(left, right) > shared(item, other) + 0.01
			);
		}),
	);
}
