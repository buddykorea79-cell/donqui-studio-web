import { collapseTracksToPills } from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import type { AxcutDocument, AxcutMediaBoardItem } from "@/lib/ai-edition/schema";
import { audioBoardOf, MIX_LABEL } from "@/lib/audio-board/board";
import { boardOf, itemDurationSec, MAX_IMAGE_SEC, MIN_ITEM_SEC } from "./board";

/**
 * Media's timeline: the soundtrack on top — the Audio tab's mix once it is applied — and the
 * composition's items below it, one after another from 0. Pure helpers for laying it out and
 * editing it; the composition itself stays the ordered list of items on the media board.
 */

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Where each item starts: one after another, from 0. */
export function itemStarts(items: AxcutMediaBoardItem[]): number[] {
	let cursor = 0;
	return items.map((item) => {
		const start = cursor;
		cursor += itemDurationSec(item);
		return start;
	});
}

export function compositionSec(items: AxcutMediaBoardItem[]): number {
	return items.reduce((sum, item) => sum + itemDurationSec(item), 0);
}

/** The item playing at `sec` — the last one past the end — or -1 without items. */
export function itemIndexAt(items: AxcutMediaBoardItem[], sec: number): number {
	if (items.length === 0) return -1;
	const starts = itemStarts(items);
	for (let index = items.length - 1; index >= 0; index--) if (sec >= starts[index]) return index;
	return 0;
}

/**
 * Where something let go at `sec` goes in the order: before the first item whose middle lies
 * past it. `exceptId` leaves the item being dragged out of the reckoning; the index is then in
 * the list without it, which is what `moveBoardItem` takes.
 */
export function insertIndexAt(
	items: AxcutMediaBoardItem[],
	sec: number,
	exceptId?: string,
): number {
	const starts = itemStarts(items);
	let index = 0;
	for (let position = 0; position < items.length; position++) {
		const item = items[position];
		if (item.id === exceptId) continue;
		if (sec < starts[position] + itemDurationSec(item) / 2) return index;
		index++;
	}
	return index;
}

/** `sec` moved onto the nearest target within `thresholdSec`, or left as it is. */
export function snapTo(sec: number, targets: number[], thresholdSec: number): number {
	let best = sec;
	let gap = thresholdSec;
	for (const target of targets) {
		const distance = Math.abs(target - sec);
		if (distance <= gap) {
			best = target;
			gap = distance;
		}
	}
	return best;
}

/**
 * The item with its head trimmed by `deltaSec` (negative: grown back). A clip or video moves
 * its in-point, within its source; a photo simply gets shorter or longer. Its end stays put.
 */
export function trimmedHead(
	item: AxcutMediaBoardItem,
	deltaSec: number,
): { startSec: number; endSec: number } {
	if (item.kind === "image") {
		const durationSec = Math.min(
			MAX_IMAGE_SEC,
			Math.max(MIN_ITEM_SEC, itemDurationSec(item) - deltaSec),
		);
		return { startSec: 0, endSec: round3(durationSec) };
	}
	const startSec = Math.min(item.endSec - MIN_ITEM_SEC, Math.max(0, item.startSec + deltaSec));
	return { startSec: round3(startSec), endSec: item.endSec };
}

/** A copy of an item right after it: same stretch of footage, same effect, the same draw. */
export function duplicateBoardItem(
	document: AxcutDocument,
	itemId: string,
): { document: AxcutDocument; id: string | null } {
	const board = boardOf(document);
	const index = board.items.findIndex((item) => item.id === itemId);
	if (index < 0) return { document, id: null };
	const copy = { ...board.items[index], id: createId("item") };
	const items = [...board.items];
	items.splice(index + 1, 0, copy);
	return { document: { ...document, mediaBoard: { ...board, items } }, id: copy.id };
}

/** One stretch of the programme's soundtrack as Media's audio row shows it. */
export interface MediaAudioClip {
	id: string;
	assetId: string;
	label: string;
	kind: "music" | "voiceover";
	/** Where it plays, in programme seconds. */
	startSec: number;
	endSec: number;
	/** Where in its file it starts. */
	offsetSec: number;
	/** The Audio tab's mix, as opposed to a track added some other way. */
	mixed: boolean;
}

/**
 * The soundtrack the pictures are fitted to: what the programme plays — after "Media에 반영",
 * the Audio tab's mix alone, from 0. Muted tracks do not count.
 */
export function mediaAudioClips(document: AxcutDocument | null): MediaAudioClip[] {
	if (!document) return [];
	const mixId = audioBoardOf(document).mix?.assetId;
	return collapseTracksToPills(document.audioTracks)
		.filter((track) => !track.muted)
		.map((track) => {
			const asset = document.assets.find((entry) => entry.id === track.assetId);
			const mixed = track.assetId === mixId;
			return {
				id: track.trackId ?? track.id,
				assetId: track.assetId,
				label: mixed ? MIX_LABEL : track.label || asset?.label || "오디오",
				kind: track.kind,
				startSec: track.startMs / 1000,
				endSec: track.endMs / 1000,
				offsetSec: track.offsetMs / 1000,
				mixed,
			};
		})
		.sort((left, right) => left.startSec - right.startSec);
}
