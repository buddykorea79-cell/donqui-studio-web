import { describe, expect, it } from "vitest";
import {
	type AxcutMediaBoardItem,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { addBoardItems, boardOf } from "./board";
import {
	compositionSec,
	duplicateBoardItem,
	insertIndexAt,
	itemIndexAt,
	itemStarts,
	mediaAudioClips,
	snapTo,
	trimmedHead,
} from "./timeline";

const item = (
	id: string,
	startSec: number,
	endSec: number,
	kind: AxcutMediaBoardItem["kind"] = "clip",
): AxcutMediaBoardItem => ({
	id,
	kind,
	...(kind === "image" ? { imageId: "photo" } : { assetId: "drone" }),
	startSec,
	endSec,
	label: id,
	effect: "none",
	seed: id,
});

// 4 s, 2 s and 3 s: at 0, 4 and 6.
const items = [item("a", 10, 14), item("b", 0, 2, "image"), item("c", 30, 33)];

describe("Media's timeline", () => {
	it("lays items one after another from 0", () => {
		expect(itemStarts(items)).toEqual([0, 4, 6]);
		expect(compositionSec(items)).toBe(9);
		expect([0, 3.9, 4, 8.5, 20].map((sec) => itemIndexAt(items, sec))).toEqual([0, 0, 1, 2, 2]);
		expect(itemIndexAt([], 1)).toBe(-1);
	});

	it("puts what is let go before the first item whose middle lies past it", () => {
		expect([0.5, 2.5, 4.9, 5.1, 9].map((sec) => insertIndexAt(items, sec))).toEqual([
			0, 1, 1, 2, 3,
		]);
		// The dragged item does not count: dropped over its own place, it stays there.
		expect(insertIndexAt(items, 5.1, "b")).toBe(1);
		expect(insertIndexAt(items, 0.5, "c")).toBe(0);
	});

	it("snaps to the nearest target within reach", () => {
		expect(snapTo(4.9, [5, 12], 0.2)).toBe(5);
		expect(snapTo(4.5, [5, 12], 0.2)).toBe(4.5);
		expect(snapTo(11.9, [5, 11.95, 12], 0.2)).toBe(11.95);
	});

	it("trims a clip's head within its source, and a photo by its length", () => {
		expect(trimmedHead(items[0], 1.5)).toEqual({ startSec: 11.5, endSec: 14 });
		expect(trimmedHead(items[0], -20)).toEqual({ startSec: 0, endSec: 14 });
		expect(trimmedHead(items[0], 10)).toEqual({ startSec: 13.5, endSec: 14 });
		expect(trimmedHead(items[1], 0.5)).toEqual({ startSec: 0, endSec: 1.5 });
		expect(trimmedHead(items[1], -3)).toEqual({ startSec: 0, endSec: 5 });
	});

	it("duplicates an item right after it, with the same draw of effect", () => {
		const document = addBoardItems(createEmptyDocument({ projectId: "p", title: "M" }), items);
		const { document: doubled, id } = duplicateBoardItem(document, "b");
		expect(boardOf(doubled).items.map((entry) => entry.label)).toEqual(["a", "b", "b", "c"]);
		const copy = boardOf(doubled).items[2];
		expect(copy.id).toBe(id);
		expect(copy.seed).toBe("b");
		expect(duplicateBoardItem(document, "missing").document).toBe(document);
	});

	it("shows the programme's soundtrack, the Audio tab's mix by its name", () => {
		const document = {
			...createEmptyDocument({ projectId: "p", title: "M" }),
			assets: [],
			audioTracks: [
				{
					...createAudioTrack({ assetId: "mix", durationSec: 12, kind: "voiceover" as const }),
					timelineLocked: true,
				},
				{ ...createAudioTrack({ assetId: "muted", durationSec: 5 }), muted: true },
			],
			audioBoard: { layers: [], mix: { assetId: "mix", signature: "" } },
		};
		expect(mediaAudioClips(document)).toEqual([
			expect.objectContaining({
				assetId: "mix",
				label: "오디오 믹스",
				kind: "voiceover",
				startSec: 0,
				endSec: 12,
				mixed: true,
			}),
		]);
		expect(mediaAudioClips(null)).toEqual([]);
	});
});
