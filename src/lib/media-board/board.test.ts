import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "@/lib/ai-edition/schema";
import { CLIP_EFFECTS } from "@/lib/clip-effects/catalog";
import {
	addBoardImages,
	addBoardItems,
	boardOf,
	clearBoardItems,
	clipItem,
	imageItem,
	isDerivedMedia,
	isSourceVideo,
	itemEffect,
	moveBoardItem,
	removeBoardClip,
	removeBoardImage,
	removeBoardItem,
	reshuffleRandomItems,
	resolvedItemEffect,
	setAllItemsEffect,
	setBoardItemRanges,
	sortedBoardClips,
	updateBoardItem,
	upsertBoardClips,
	videoItem,
} from "./board";

const drone = {
	id: "drone",
	kind: "video" as const,
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	cameraTrack: null,
};
const beach = { ...drone, id: "beach", label: "BEACH.MP4", originalPath: "C:/footage/BEACH.MP4" };

function base(): AxcutDocument {
	return { ...createEmptyDocument({ projectId: "p", title: "Board" }), assets: [drone, beach] };
}

function withClips() {
	return upsertBoardClips(base(), [
		{ assetId: "beach", startSec: 3, endSec: 8, label: "BEACH 3" },
		{ assetId: "drone", startSec: 10, endSec: 15, label: "DJI 10", score: 90, note: "절벽" },
		{ assetId: "drone", startSec: 0, endSec: 5, label: "DJI 0" },
	]);
}

describe("the bin", () => {
	it("adds split clips and lists them in filmed order", () => {
		const { document, ids } = withClips();
		expect(ids).toHaveLength(3);
		const board = boardOf(document);
		expect(board.clips[1]).toMatchObject({ score: 90, note: "절벽" });
		expect(
			sortedBoardClips(board, document.assets).map((clip) => [clip.assetId, clip.startSec]),
		).toEqual([
			["drone", 0],
			["drone", 10],
			["beach", 3],
		]);
	});

	it("updates a clip by id, and finds the same range instead of repeating it", () => {
		const { document, ids } = withClips();
		const again = upsertBoardClips(document, [
			{ id: ids[1], assetId: "drone", startSec: 10, endSec: 17, label: "DJI 10" },
			{ assetId: "beach", startSec: 3, endSec: 8, label: "BEACH 3 again" },
		]);
		expect(again.ids).toEqual([ids[1], ids[0]]);
		const clips = boardOf(again.document).clips;
		expect(clips).toHaveLength(3);
		expect(clips.find((clip) => clip.id === ids[1])).toMatchObject({ endSec: 17 });
	});

	it("keeps the items made from a removed clip, unlinked", () => {
		const { document, ids } = withClips();
		const clip = boardOf(document).clips[0];
		const composed = addBoardItems(document, [clipItem(clip, { effect: "zoom-in" })]);
		const removed = removeBoardClip(composed, ids[0]);
		expect(boardOf(removed).clips).toHaveLength(2);
		expect(boardOf(removed).items[0]).toMatchObject({ clipId: undefined, startSec: 3, endSec: 8 });
		expect(removeBoardClip(removed, "gone")).toBe(removed);
	});
});

describe("photos", () => {
	it("adds each photo once, whatever the path's case or slashes", () => {
		const first = addBoardImages(base(), [
			{ path: "C:\\photos\\a.jpg", label: "a.jpg", width: 4000, height: 3000 },
			{ path: "C:\\photos\\b.jpg", label: "b.jpg" },
		]);
		const second = addBoardImages(first.document, [{ path: "c:/Photos/A.JPG", label: "a again" }]);
		expect(second.ids).toEqual([first.ids[0]]);
		expect(boardOf(second.document).images).toHaveLength(2);
		expect(boardOf(second.document).images[0]).toMatchObject({ width: 4000, height: 3000 });
	});

	it("takes the photo's items with it", () => {
		const { document, ids } = addBoardImages(base(), [{ path: "C:/a.jpg", label: "a" }]);
		const image = boardOf(document).images[0];
		const composed = addBoardItems(document, [imageItem(image, 4, { effect: "none" })]);
		const removed = removeBoardImage(composed, ids[0]);
		expect(boardOf(removed).images).toEqual([]);
		expect(boardOf(removed).items).toEqual([]);
	});
});

describe("the composition", () => {
	function composed() {
		const { document } = withClips();
		const board = boardOf(document);
		const photos = addBoardImages(document, [{ path: "C:/a.jpg", label: "a.jpg" }]);
		return addBoardItems(photos.document, [
			clipItem(board.clips[0], { effect: "none" }),
			imageItem(boardOf(photos.document).images[0], 4, { effect: "fade" }),
			videoItem(drone, 30, { effect: "random", seed: "fixed" }),
		]);
	}

	it("makes items that carry their own range and effect", () => {
		const items = boardOf(composed()).items;
		expect(items.map((item) => [item.kind, item.startSec, item.endSec, item.effect])).toEqual([
			["clip", 3, 8, "none"],
			["image", 0, 4, "fade"],
			["video", 0, 30, "random"],
		]);
		expect(resolvedItemEffect(items[2])).toBe(resolvedItemEffect({ ...items[2], id: "other" }));
	});

	it("inserts, moves and removes items", () => {
		const document = composed();
		const [clip, photo, video] = boardOf(document).items;
		const moved = moveBoardItem(document, video.id, 0);
		expect(boardOf(moved).items.map((item) => item.id)).toEqual([video.id, clip.id, photo.id]);
		expect(moveBoardItem(moved, "gone", 1)).toBe(moved);
		const removed = removeBoardItem(moved, clip.id);
		expect(boardOf(removed).items.map((item) => item.id)).toEqual([video.id, photo.id]);
		const inserted = addBoardItems(
			removed,
			[clipItem(boardOf(removed).clips[1], { effect: "none" })],
			1,
		);
		expect(boardOf(inserted).items[1].kind).toBe("clip");
		expect(boardOf(clearBoardItems(inserted)).items).toEqual([]);
	});

	it("refuses a range shorter than half a second or ending before it starts", () => {
		const document = composed();
		const clip = boardOf(document).items[0];
		expect(updateBoardItem(document, clip.id, { endSec: 3.2 })).toBe(document);
		expect(updateBoardItem(document, clip.id, { startSec: 9 })).toBe(document);
		const longer = updateBoardItem(document, clip.id, { endSec: 10 });
		expect(boardOf(longer).items[0].endSec).toBe(10);
	});

	it("sets every range of a fit in one edit", () => {
		const document = composed();
		const [clip, photo] = boardOf(document).items;
		const fitted = setBoardItemRanges(
			document,
			new Map([
				[clip.id, { startSec: 3, endSec: 9 }],
				[photo.id, { startSec: 0, endSec: 6 }],
			]),
		);
		expect(boardOf(fitted).items.map((item) => item.endSec)).toEqual([9, 6, 30]);
	});

	it("gives every item one effect, and a random one a fresh draw each", () => {
		const document = setAllItemsEffect(composed(), "random");
		const items = boardOf(document).items;
		expect(items.every((item) => item.effect === "random")).toBe(true);
		expect(new Set(items.map((item) => item.seed)).size).toBe(3);
		const reshuffled = boardOf(reshuffleRandomItems(document)).items;
		expect(reshuffled.every((item, index) => item.seed !== items[index].seed)).toBe(true);
		const none = setAllItemsEffect(document, "pan-left");
		expect(boardOf(reshuffleRandomItems(none)).items).toEqual(boardOf(none).items);
	});

	it("plays an effect it does not know as none", () => {
		expect(itemEffect({ effect: "sparkle-2030" })).toBe("none");
		expect(itemEffect({ effect: "random" })).toBe("random");
		expect(itemEffect({ effect: CLIP_EFFECTS[0].id })).toBe(CLIP_EFFECTS[0].id);
	});

	it("survives the document schema, and a document without a board still parses", () => {
		const document = composed();
		const parsed = documentSchema.parse(JSON.parse(JSON.stringify(document)));
		expect(parsed.mediaBoard).toEqual(document.mediaBoard);
		expect(documentSchema.parse(JSON.parse(JSON.stringify(base()))).mediaBoard).toBeUndefined();
	});
});

describe("footage", () => {
	it("tells the videos the user brought from the files this app rendered", () => {
		expect(isSourceVideo(drone)).toBe(true);
		expect(isSourceVideo({ ...drone, kind: "audio" })).toBe(false);
		expect(
			isDerivedMedia({
				originalPath: "C:\\Users\\me\\AppData\\Donqui\\media\\clip-effects\\ab.mp4",
			}),
		).toBe(true);
		expect(
			isDerivedMedia({ originalPath: "/home/me/.config/donqui/media/image-clips/cd.mp4" }),
		).toBe(true);
		expect(isSourceVideo({ ...drone, originalPath: "D:/media/clip-effects-demo.mp4" })).toBe(true);
	});
});
