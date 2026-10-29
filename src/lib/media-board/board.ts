import { createId } from "@/lib/ai-edition/document/ids";
import type {
	AxcutAsset,
	AxcutDocument,
	AxcutMediaBoard,
	AxcutMediaBoardClip,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import {
	type ClipEffectId,
	type ClipEffectSelection,
	isClipEffectId,
	resolveClipEffect,
} from "@/lib/clip-effects/catalog";

/**
 * The media board: V.Clip's split clips (the bin), the photos Media imported, and the
 * composition Media builds from them. Pure functions over the document — every change returns
 * a new document, and the stores decide when to save it.
 */

export const EMPTY_BOARD: AxcutMediaBoard = { clips: [], images: [], items: [] };

/** Length a photo gets when it joins the composition, until the user or an audio fit changes it. */
export const DEFAULT_IMAGE_SEC = 5;
/** Shortest item the composition keeps; a render or a timeline clip below this is a flicker. */
export const MIN_ITEM_SEC = 0.5;
/** Longest photo, matching the image-clip converter's bound. */
export const MAX_IMAGE_SEC = 600;

/**
 * A file this app rendered — an effect clip or a photo still — rather than footage the user
 * brought: something applying the composition made, not something to split or compose.
 */
export function isDerivedMedia(asset: Pick<AxcutAsset, "originalPath">): boolean {
	return /[\\/]media[\\/](clip-effects|image-clips)[\\/]/.test(asset.originalPath);
}

/** Footage for V.Clip and Media: the project's videos, not its audio or its renders. */
export function isSourceVideo(asset: Pick<AxcutAsset, "kind" | "originalPath">): boolean {
	return asset.kind !== "audio" && !isDerivedMedia(asset);
}

export function boardOf(document: AxcutDocument | null | undefined): AxcutMediaBoard {
	return document?.mediaBoard ?? EMPTY_BOARD;
}

function withBoard(document: AxcutDocument, board: AxcutMediaBoard): AxcutDocument {
	return { ...document, mediaBoard: board };
}

export function itemDurationSec(item: Pick<AxcutMediaBoardItem, "startSec" | "endSec">): number {
	return Math.max(0, item.endSec - item.startSec);
}

/** The effect an item asks for. An id this build does not know (a newer build's) plays as none. */
export function itemEffect(item: Pick<AxcutMediaBoardItem, "effect">): ClipEffectSelection {
	return item.effect === "random" || isClipEffectId(item.effect) ? item.effect : "none";
}

/** What the item renders with: "random" resolved by the item's seed, the same way every time. */
export function resolvedItemEffect(
	item: Pick<AxcutMediaBoardItem, "effect" | "seed" | "id">,
): ClipEffectId {
	return resolveClipEffect(itemEffect(item), item.seed || item.id);
}

const close = (left: number, right: number) => Math.abs(left - right) < 0.005;

// ─── The bin: V.Clip's clips ─────────────────────────────────────────

export interface ClipDraft {
	/** The bin clip to update; a new one is made without it. */
	id?: string;
	assetId: string;
	startSec: number;
	endSec: number;
	label: string;
	score?: number;
	note?: string;
}

/**
 * Puts split clips into the bin. A draft naming an existing clip updates it — a segment
 * adjusted after it was split — and one repeating a clip's exact range is that clip.
 * Resolves each draft to the id of the clip it became.
 */
export function upsertBoardClips(
	document: AxcutDocument,
	drafts: ClipDraft[],
): { document: AxcutDocument; ids: string[] } {
	const board = boardOf(document);
	const clips = [...board.clips];
	const ids = drafts.map((draft) => {
		const startSec = Math.max(0, draft.startSec);
		const endSec = Math.max(startSec, draft.endSec);
		const index = draft.id ? clips.findIndex((clip) => clip.id === draft.id) : -1;
		if (index >= 0) {
			clips[index] = {
				...clips[index],
				assetId: draft.assetId,
				startSec,
				endSec,
				label: draft.label,
				score: draft.score,
				note: draft.note,
			};
			return clips[index].id;
		}
		const same = clips.find(
			(clip) =>
				clip.assetId === draft.assetId &&
				close(clip.startSec, startSec) &&
				close(clip.endSec, endSec),
		);
		if (same) return same.id;
		const clip: AxcutMediaBoardClip = {
			id: createId("vclip"),
			assetId: draft.assetId,
			startSec,
			endSec,
			label: draft.label,
			...(draft.score === undefined ? {} : { score: draft.score }),
			...(draft.note ? { note: draft.note } : {}),
		};
		clips.push(clip);
		return clip.id;
	});
	return { document: withBoard(document, { ...board, clips }), ids };
}

/** Takes a clip out of the bin. Items made from it keep playing: they carry their own range. */
export function removeBoardClip(document: AxcutDocument, clipId: string): AxcutDocument {
	const board = boardOf(document);
	if (!board.clips.some((clip) => clip.id === clipId)) return document;
	return withBoard(document, {
		...board,
		clips: board.clips.filter((clip) => clip.id !== clipId),
		items: board.items.map((item) =>
			item.clipId === clipId ? { ...item, clipId: undefined } : item,
		),
	});
}

/** The bin in filmed order: by source (in media order), then by start. */
export function sortedBoardClips(
	board: AxcutMediaBoard,
	assets: AxcutAsset[],
): AxcutMediaBoardClip[] {
	const order = new Map(assets.map((asset, index) => [asset.id, index]));
	return [...board.clips].sort(
		(left, right) =>
			(order.get(left.assetId) ?? Number.MAX_SAFE_INTEGER) -
				(order.get(right.assetId) ?? Number.MAX_SAFE_INTEGER) || left.startSec - right.startSec,
	);
}

// ─── Photos ──────────────────────────────────────────────────────────

export interface ImageDraft {
	path: string;
	label: string;
	width?: number;
	height?: number;
}

/** Adds photos to the board, once each: picking a photo that is already there finds it. */
export function addBoardImages(
	document: AxcutDocument,
	drafts: ImageDraft[],
): { document: AxcutDocument; ids: string[] } {
	const board = boardOf(document);
	const images = [...board.images];
	const ids = drafts.map((draft) => {
		const existing = images.find((image) => samePath(image.path, draft.path));
		if (existing) return existing.id;
		const image: AxcutMediaBoardImage = {
			id: createId("photo"),
			path: draft.path,
			label: draft.label,
			...(draft.width && draft.height ? { width: draft.width, height: draft.height } : {}),
		};
		images.push(image);
		return image.id;
	});
	return { document: withBoard(document, { ...board, images }), ids };
}

/** Removes a photo, and the composition items that showed it. */
export function removeBoardImage(document: AxcutDocument, imageId: string): AxcutDocument {
	const board = boardOf(document);
	if (!board.images.some((image) => image.id === imageId)) return document;
	return withBoard(document, {
		...board,
		images: board.images.filter((image) => image.id !== imageId),
		items: board.items.filter((item) => item.imageId !== imageId),
	});
}

export function samePath(left: string, right: string): boolean {
	const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
	return normalize(left) === normalize(right);
}

// ─── The composition ─────────────────────────────────────────────────

export interface ItemEffectChoice {
	effect: ClipEffectSelection;
	/** Seeds a random pick; one is made when absent. */
	seed?: string;
}

function newSeed(): string {
	return createId("seed");
}

export function clipItem(clip: AxcutMediaBoardClip, choice: ItemEffectChoice): AxcutMediaBoardItem {
	return {
		id: createId("item"),
		kind: "clip",
		assetId: clip.assetId,
		clipId: clip.id,
		startSec: clip.startSec,
		endSec: clip.endSec,
		label: clip.label,
		effect: choice.effect,
		seed: choice.seed ?? newSeed(),
	};
}

export function videoItem(
	asset: Pick<AxcutAsset, "id" | "label">,
	durationSec: number,
	choice: ItemEffectChoice,
): AxcutMediaBoardItem {
	return {
		id: createId("item"),
		kind: "video",
		assetId: asset.id,
		startSec: 0,
		endSec: Math.max(MIN_ITEM_SEC, durationSec),
		label: asset.label,
		effect: choice.effect,
		seed: choice.seed ?? newSeed(),
	};
}

export function imageItem(
	image: AxcutMediaBoardImage,
	durationSec: number,
	choice: ItemEffectChoice,
): AxcutMediaBoardItem {
	return {
		id: createId("item"),
		kind: "image",
		imageId: image.id,
		startSec: 0,
		endSec: Math.min(MAX_IMAGE_SEC, Math.max(MIN_ITEM_SEC, durationSec)),
		label: image.label,
		effect: choice.effect,
		seed: choice.seed ?? newSeed(),
	};
}

/** Inserts items at `index` (the end when absent). */
export function addBoardItems(
	document: AxcutDocument,
	items: AxcutMediaBoardItem[],
	index?: number,
): AxcutDocument {
	if (items.length === 0) return document;
	const board = boardOf(document);
	const next = [...board.items];
	const at = index === undefined ? next.length : Math.max(0, Math.min(next.length, index));
	next.splice(at, 0, ...items);
	return withBoard(document, { ...board, items: next });
}

export type ItemPatch = Partial<
	Pick<AxcutMediaBoardItem, "startSec" | "endSec" | "effect" | "seed">
>;

/** Changes one item. A range that ends before it starts, or is shorter than a flicker, is refused. */
export function updateBoardItem(
	document: AxcutDocument,
	itemId: string,
	patch: ItemPatch,
): AxcutDocument {
	const board = boardOf(document);
	const current = board.items.find((item) => item.id === itemId);
	if (!current) return document;
	const next = { ...current, ...patch };
	if (
		!Number.isFinite(next.startSec) ||
		!Number.isFinite(next.endSec) ||
		next.startSec < 0 ||
		next.endSec - next.startSec < MIN_ITEM_SEC - 1e-6
	)
		return document;
	return withBoard(document, {
		...board,
		items: board.items.map((item) => (item.id === itemId ? next : item)),
	});
}

/** Replaces every item's range at once — an audio fit is one edit, undone as one. */
export function setBoardItemRanges(
	document: AxcutDocument,
	ranges: Map<string, { startSec: number; endSec: number }>,
): AxcutDocument {
	const board = boardOf(document);
	return withBoard(document, {
		...board,
		items: board.items.map((item) => {
			const range = ranges.get(item.id);
			return range ? { ...item, ...range } : item;
		}),
	});
}

export function moveBoardItem(
	document: AxcutDocument,
	itemId: string,
	toIndex: number,
): AxcutDocument {
	const board = boardOf(document);
	const from = board.items.findIndex((item) => item.id === itemId);
	if (from < 0) return document;
	const to = Math.max(0, Math.min(board.items.length - 1, toIndex));
	if (to === from) return document;
	const items = [...board.items];
	const [moved] = items.splice(from, 1);
	items.splice(to, 0, moved);
	return withBoard(document, { ...board, items });
}

export function removeBoardItem(document: AxcutDocument, itemId: string): AxcutDocument {
	const board = boardOf(document);
	if (!board.items.some((item) => item.id === itemId)) return document;
	return withBoard(document, { ...board, items: board.items.filter((item) => item.id !== itemId) });
}

export function clearBoardItems(document: AxcutDocument): AxcutDocument {
	const board = boardOf(document);
	return board.items.length === 0 ? document : withBoard(document, { ...board, items: [] });
}

/** One effect for every item. A random choice gets a fresh seed per item, so they differ. */
export function setAllItemsEffect(
	document: AxcutDocument,
	effect: ClipEffectSelection,
): AxcutDocument {
	const board = boardOf(document);
	return withBoard(document, {
		...board,
		items: board.items.map((item) => ({
			...item,
			effect,
			seed: effect === "random" ? newSeed() : item.seed,
		})),
	});
}

/** New seeds for every random item: a different draw of effects. */
export function reshuffleRandomItems(document: AxcutDocument): AxcutDocument {
	const board = boardOf(document);
	if (!board.items.some((item) => itemEffect(item) === "random")) return document;
	return withBoard(document, {
		...board,
		items: board.items.map((item) =>
			itemEffect(item) === "random" ? { ...item, seed: newSeed() } : item,
		),
	});
}
