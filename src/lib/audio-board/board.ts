import {
	collapseTracksToPills,
	resolveFadeSecs,
	trackGroupId,
} from "@/lib/ai-edition/document/audioTracks";
import { createId } from "@/lib/ai-edition/document/ids";
import { setWordText } from "@/lib/ai-edition/document/transcript";
import {
	type AxcutAsset,
	type AxcutAudioBoard,
	type AxcutAudioBoardLayer,
	type AxcutAudioBoardSource,
	type AxcutAudioTrack,
	type AxcutDocument,
	type AxcutTranscript,
	createAudioTrack,
} from "@/lib/ai-edition/schema";
import { findAssetTranscript } from "@/lib/ai-edition/transcription/status";

/**
 * The Audio tab's board. An imported music or narration file goes into the clip LIBRARY, and
 * each use of it on the timeline is a CLIP (stored as a layer): which row it sits on, where it
 * starts, which stretch of its file it plays, how loud, and its fades. One file can be placed
 * any number of times, and clips on one row never overlap. Applying the board mixes the clips
 * into one file, and the programme plays that MIX as its only audio track — which is what Media
 * fits its composition to. Pure operations; the store writes them.
 */

/** The shortest stretch of a file a layer can play. */
export const MIN_LAYER_SEC = 0.1;
/** Volume is a percentage of the file's own level; 400% is the old +12 dB ceiling. */
export const MAX_VOLUME = 400;
export const MIX_LABEL = "오디오 믹스";
/** How many copies "repeat to the end" makes at most: a one-second loop over an hour is enough. */
export const MAX_REPEATS = 500;

export type LayerKind = AxcutAudioBoardLayer["kind"];

export type LayerPatch = Partial<
	Pick<
		AxcutAudioBoardLayer,
		| "kind"
		| "label"
		| "startSec"
		| "inSec"
		| "outSec"
		| "volume"
		| "fadeInSec"
		| "fadeOutSec"
		| "muted"
		| "row"
	>
>;

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Clips closer than this touch rather than overlap: float noise on a shared edge is no clash. */
const EPSILON = 0.0005;

export function audioBoardOf(document: AxcutDocument | null): AxcutAudioBoard {
	return document?.audioBoard ?? { layers: [] };
}

function withBoard(document: AxcutDocument, board: AxcutAudioBoard): AxcutDocument {
	return { ...document, audioBoard: board };
}

export const layerSpanSec = (layer: AxcutAudioBoardLayer) =>
	Math.max(0, layer.outSec - layer.inSec);
export const layerEndSec = (layer: AxcutAudioBoardLayer) => layer.startSec + layerSpanSec(layer);
export const isAudible = (layer: AxcutAudioBoardLayer) =>
	!layer.muted && layer.volume > 0 && layerSpanSec(layer) > 0;

/** Where the last layer ends — what the board's timeline has to show. */
export function boardEndSec(layers: AxcutAudioBoardLayer[]): number {
	return layers.reduce((end, layer) => Math.max(end, layerEndSec(layer)), 0);
}

/** How long the mix runs: to the end of the last layer that makes a sound. */
export function mixDurationSec(layers: AxcutAudioBoardLayer[]): number {
	return round3(boardEndSec(layers.filter(isAudible)));
}

/** A dB gain as the percentage the Audio tab shows: 0 dB is 100%, -6 dB about 50%. */
export function volumeFromGainDb(gainDb: number): number {
	return clampVolume(100 * 10 ** (gainDb / 20));
}

export function clampVolume(volume: number): number {
	return Number.isFinite(volume) ? clamp(Math.round(volume), 0, MAX_VOLUME) : 100;
}

export function layerLabel(document: AxcutDocument | null, layer: AxcutAudioBoardLayer): string {
	return (
		layer.label ||
		document?.assets.find((asset) => asset.id === layer.assetId)?.label ||
		(layer.kind === "music" ? "음악" : "나레이션")
	);
}

// ─── Rows ────────────────────────────────────────────────────────────

/**
 * Every layer with its row. A layer from before rows existed had a row of its own; it keeps
 * one, after the rows already taken, in board order — so an old board looks as it always did.
 */
export function withRows(layers: AxcutAudioBoardLayer[]): AxcutAudioBoardLayer[] {
	if (layers.every((layer) => layer.row !== undefined)) return layers;
	let next = Math.max(-1, ...layers.map((layer) => layer.row ?? -1)) + 1;
	return layers.map((layer) => (layer.row !== undefined ? layer : { ...layer, row: next++ }));
}

export const layerRow = (layer: AxcutAudioBoardLayer): number => layer.row ?? 0;

/** The layers as the timeline shows them, each with its row. */
export function boardLayers(document: AxcutDocument | null): AxcutAudioBoardLayer[] {
	return withRows(audioBoardOf(document).layers);
}

/** The rows in use, top to bottom. */
export function boardRows(layers: AxcutAudioBoardLayer[]): number[] {
	return [...new Set(withRows(layers).map(layerRow))].sort((left, right) => left - right);
}

/** Rows renumbered 0, 1, 2… in order, so an emptied row leaves no gap behind. */
function compactRows(layers: AxcutAudioBoardLayer[]): AxcutAudioBoardLayer[] {
	const resolved = withRows(layers);
	const order = new Map(boardRows(resolved).map((row, index) => [row, index]));
	return resolved.map((layer) =>
		order.get(layerRow(layer)) === layerRow(layer)
			? layer
			: { ...layer, row: order.get(layerRow(layer)) ?? 0 },
	);
}

/** The kind a row holds: its clips' kind when they agree, else null. */
export function rowKind(layers: AxcutAudioBoardLayer[], row: number): LayerKind | null {
	const kinds = new Set(
		withRows(layers)
			.filter((layer) => layerRow(layer) === row)
			.map((layer) => layer.kind),
	);
	return kinds.size === 1 ? [...kinds][0] : null;
}

/** The row a new clip of `kind` goes on: the first holding only that kind, else a new one. */
export function rowForKind(layers: AxcutAudioBoardLayer[], kind: LayerKind): number {
	const rows = boardRows(layers);
	return rows.find((row) => rowKind(layers, row) === kind) ?? (rows.at(-1) ?? -1) + 1;
}

/** Where a row's clips sit, in order, leaving out `exceptId`. */
function rowSpans(
	layers: AxcutAudioBoardLayer[],
	row: number,
	exceptId?: string,
): Array<[number, number]> {
	return withRows(layers)
		.filter((layer) => layerRow(layer) === row && layer.id !== exceptId)
		.map((layer): [number, number] => [layer.startSec, layerEndSec(layer)])
		.sort((left, right) => left[0] - right[0]);
}

function fitsAt(spans: Array<[number, number]>, start: number, span: number): boolean {
	return spans.every(([from, to]) => start + span <= from + EPSILON || start >= to - EPSILON);
}

/** The first start at or after `atSec` where `span` seconds fit between a row's clips. */
export function freeStartAfter(
	spans: Array<[number, number]>,
	atSec: number,
	span: number,
): number {
	let start = Math.max(0, atSec);
	for (const [from, to] of spans) {
		if (start + span <= from + EPSILON) break;
		if (start < to - EPSILON) start = to;
	}
	return round3(start);
}

/** The start nearest `desired` where `span` seconds fit between a row's clips. */
export function nearestFreeStart(
	spans: Array<[number, number]>,
	desired: number,
	span: number,
): number {
	const wanted = Number.isFinite(desired) ? Math.max(0, desired) : 0;
	if (fitsAt(spans, wanted, span)) return round3(wanted);
	let best = freeStartAfter(spans, wanted, span);
	let edge = 0;
	for (const [from, to] of spans) {
		// The gap before this clip, if the span fits in it: as close to `wanted` as it allows.
		if (from - edge >= span - EPSILON) {
			const candidate = clamp(wanted, edge, from - span);
			if (Math.abs(candidate - wanted) < Math.abs(best - wanted)) best = candidate;
		}
		edge = Math.max(edge, to);
	}
	return round3(Math.max(0, best));
}

// ─── The library ─────────────────────────────────────────────────────

/** A file this app mixed, not one the user brought: the mix never joins the library. */
export function isMixFile(asset: Pick<AxcutAsset, "originalPath">): boolean {
	return /[\\/]media[\\/]audio-mixes[\\/]/.test(asset.originalPath);
}

/**
 * The clip library: the files imported into Audio, each once, with the kind it was imported
 * as. A board written before the library existed has its layers' files as its library.
 */
export function libraryOf(document: AxcutDocument | null): AxcutAudioBoardSource[] {
	if (!document) return [];
	const board = audioBoardOf(document);
	const entries: AxcutAudioBoardSource[] = [...(board.library ?? [])];
	for (const layer of withRows(board.layers))
		if (!entries.some((entry) => entry.assetId === layer.assetId))
			entries.push({ assetId: layer.assetId, kind: layer.kind });
	return entries.filter((entry) =>
		document.assets.some(
			(asset) =>
				asset.id === entry.assetId &&
				asset.kind === "audio" &&
				!isMixFile(asset) &&
				asset.id !== board.mix?.assetId,
		),
	);
}

function withLibrary(
	board: AxcutAudioBoard,
	sources: AxcutAudioBoardSource[],
): AxcutAudioBoard["library"] {
	const library = [...(board.library ?? [])];
	for (const source of sources)
		if (!library.some((entry) => entry.assetId === source.assetId)) library.push(source);
	return library;
}

// ─── Placing clips ───────────────────────────────────────────────────

export interface LayerDraft {
	assetId: string;
	kind: LayerKind;
	label: string;
	durationSec: number;
	/** The row to place it on; the first row of its kind (or a new one) when absent. */
	row?: number;
	/** Where to place it; the end of its row when absent. It moves to the nearest free spot. */
	atSec?: number;
}

/**
 * Places files as clips that play whole. A clip goes at the end of the first row of its kind —
 * narrations imported together line up back to back on one row, songs on another — or where it
 * was dropped, moved to the nearest spot its row has room for. Its file joins the library.
 */
export function addLayers(
	document: AxcutDocument,
	drafts: LayerDraft[],
): { document: AxcutDocument; ids: string[] } {
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	const ids: string[] = [];
	for (const draft of drafts) {
		if (!(draft.durationSec > 0)) continue;
		const row = draft.row ?? rowForKind(layers, draft.kind);
		const spans = rowSpans(layers, row);
		const span = round3(draft.durationSec);
		const startSec =
			draft.atSec === undefined || !Number.isFinite(draft.atSec)
				? freeStartAfter(spans, spans.at(-1)?.[1] ?? 0, span)
				: nearestFreeStart(spans, draft.atSec, span);
		const layer: AxcutAudioBoardLayer = {
			id: createId("layer"),
			assetId: draft.assetId,
			kind: draft.kind,
			label: draft.label,
			startSec: round3(startSec),
			inSec: 0,
			outSec: span,
			volume: 100,
			fadeInSec: 0,
			fadeOutSec: 0,
			muted: false,
			row,
		};
		layers.push(layer);
		ids.push(layer.id);
	}
	const library = withLibrary(
		board,
		drafts.map((draft) => ({ assetId: draft.assetId, kind: draft.kind })),
	);
	if (ids.length === 0 && library?.length === (board.library?.length ?? 0))
		return { document, ids };
	return { document: withBoard(document, { ...board, layers: compactRows(layers), library }), ids };
}

/** Files into the library without placing them — what a clip removed from every row leaves. */
export function addToLibrary(
	document: AxcutDocument,
	sources: AxcutAudioBoardSource[],
): AxcutDocument {
	const board = audioBoardOf(document);
	const library = withLibrary(board, sources);
	if (library?.length === (board.library?.length ?? 0)) return document;
	return withBoard(document, { ...board, library });
}

/** `patch` applied and kept playable: inside its file, at least MIN_LAYER_SEC, fades inside it. */
export function normalizedLayer(
	layer: AxcutAudioBoardLayer,
	patch: LayerPatch,
	sourceDurationSec?: number,
): AxcutAudioBoardLayer {
	const next = { ...layer, ...patch };
	const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
	const limit =
		sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec : Number.POSITIVE_INFINITY;
	const inSec = clamp(finite(next.inSec, layer.inSec), 0, Math.max(0, limit - MIN_LAYER_SEC));
	const outSec = clamp(finite(next.outSec, layer.outSec), inSec + MIN_LAYER_SEC, limit);
	const span = outSec - inSec;
	return {
		...next,
		startSec: round3(Math.max(0, finite(next.startSec, layer.startSec))),
		inSec: round3(inSec),
		outSec: round3(outSec),
		volume: clampVolume(finite(next.volume, layer.volume)),
		fadeInSec: round3(clamp(finite(next.fadeInSec, layer.fadeInSec), 0, span)),
		fadeOutSec: round3(clamp(finite(next.fadeOutSec, layer.fadeOutSec), 0, span)),
		...(next.row === undefined ? {} : { row: Math.max(0, Math.round(finite(next.row, 0))) }),
	};
}

/**
 * `next` kept clear of its row's other clips. A move goes to the nearest spot with room; a trim
 * stops at the neighbour it ran into, the in-point carrying the start with it as it always does.
 */
export function clearOfRow(
	layers: AxcutAudioBoardLayer[],
	previous: AxcutAudioBoardLayer,
	next: AxcutAudioBoardLayer,
): AxcutAudioBoardLayer {
	const spans = rowSpans(layers, layerRow(next), next.id);
	const span = layerSpanSec(next);
	if (fitsAt(spans, next.startSec, span)) return next;
	const trimmedIn =
		next.inSec !== previous.inSec && Math.abs(layerEndSec(next) - layerEndSec(previous)) < 0.002;
	const trimmedOut = next.outSec !== previous.outSec && next.startSec === previous.startSec;
	if (trimmedIn) {
		const floor = Math.max(
			0,
			...spans.filter(([, to]) => to <= layerEndSec(previous) + EPSILON).map(([, to]) => to),
		);
		const shift = Math.max(0, floor - next.startSec);
		return { ...next, startSec: round3(next.startSec + shift), inSec: round3(next.inSec + shift) };
	}
	if (trimmedOut) {
		const ceiling = Math.min(
			...spans.filter(([from]) => from >= next.startSec - EPSILON).map(([from]) => from),
		);
		return Number.isFinite(ceiling)
			? {
					...next,
					outSec: round3(
						Math.max(next.inSec + MIN_LAYER_SEC, next.inSec + ceiling - next.startSec),
					),
				}
			: next;
	}
	return { ...next, startSec: nearestFreeStart(spans, next.startSec, span) };
}

const LAYER_FIELDS = [
	"kind",
	"label",
	"startSec",
	"inSec",
	"outSec",
	"volume",
	"fadeInSec",
	"fadeOutSec",
	"muted",
	"row",
] as const;

/** The layer as `patch` leaves it: normalized, and clear of the other clips on its row. */
export function patchedLayer(
	document: AxcutDocument,
	id: string,
	patch: LayerPatch,
): AxcutAudioBoardLayer | null {
	const layers = boardLayers(document);
	const layer = layers.find((entry) => entry.id === id);
	if (!layer) return null;
	const source = document.assets.find((asset) => asset.id === layer.assetId)?.durationSec;
	return clearOfRow(layers, layer, normalizedLayer(layer, patch, source));
}

export function updateLayer(document: AxcutDocument, id: string, patch: LayerPatch): AxcutDocument {
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	const layer = layers.find((entry) => entry.id === id);
	if (!layer) return document;
	const next = patchedLayer(document, id, patch);
	if (!next || LAYER_FIELDS.every((field) => next[field] === layer[field])) return document;
	const moved = layers.map((entry) => (entry.id === id ? next : entry));
	return withBoard(document, {
		...board,
		layers: next.row === layer.row ? moved : compactRows(moved),
	});
}

/** A copy of a clip, right after it on its row — or at the first spot there with room. */
export function duplicateLayer(
	document: AxcutDocument,
	id: string,
): { document: AxcutDocument; id: string | null } {
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	const layer = layers.find((entry) => entry.id === id);
	if (!layer) return { document, id: null };
	// A copy is the user's own clip: it does not stand for the programme track the original
	// may have been taken from.
	const { trackId: _taken, ...rest } = layer;
	const copy: AxcutAudioBoardLayer = {
		...rest,
		id: createId("layer"),
		startSec: freeStartAfter(
			rowSpans(layers, layerRow(layer)),
			layerEndSec(layer),
			layerSpanSec(layer),
		),
	};
	return {
		document: withBoard(document, { ...board, layers: [...layers, copy] }),
		id: copy.id,
	};
}

/**
 * A copy of `source` — a clip copied earlier, perhaps since deleted — on `row`, at the spot
 * nearest `atSec` the row has room for. Nothing when its file is no longer in the project.
 */
export function placeLayerCopy(
	document: AxcutDocument,
	source: AxcutAudioBoardLayer,
	row: number,
	atSec: number,
): { document: AxcutDocument; id: string | null } {
	if (!document.assets.some((asset) => asset.id === source.assetId)) return { document, id: null };
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	const { trackId: _taken, ...rest } = source;
	const copy: AxcutAudioBoardLayer = {
		...rest,
		id: createId("layer"),
		row,
		startSec: nearestFreeStart(rowSpans(layers, row), atSec, layerSpanSec(source)),
	};
	return {
		document: withBoard(document, {
			...board,
			layers: compactRows([...layers, copy]),
			library: withLibrary(board, [{ assetId: source.assetId, kind: source.kind }]),
		}),
		id: copy.id,
	};
}

/**
 * Copies of a clip back to back after it, until its row reaches the end of the other rows —
 * music under a longer narration. The last copy is cut to end exactly there. Nothing happens
 * when the row already reaches that far.
 */
export function repeatLayerToEnd(
	document: AxcutDocument,
	id: string,
): { document: AxcutDocument; count: number } {
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	const layer = layers.find((entry) => entry.id === id);
	if (!layer) return { document, count: 0 };
	const row = layerRow(layer);
	const target = boardEndSec(layers.filter((entry) => layerRow(entry) !== row));
	const span = layerSpanSec(layer);
	const added: AxcutAudioBoardLayer[] = [];
	let cursor = layerEndSec(layer);
	while (added.length < MAX_REPEATS && target - cursor >= MIN_LAYER_SEC && span > 0) {
		const start = freeStartAfter(rowSpans([...layers, ...added], row), cursor, 0);
		if (target - start < MIN_LAYER_SEC) break;
		// Room up to the next clip on the row, or to the target.
		const next = rowSpans([...layers, ...added], row).find(([from]) => from >= start - EPSILON);
		const room = Math.min(target, next ? next[0] : Number.POSITIVE_INFINITY) - start;
		if (room < MIN_LAYER_SEC) {
			cursor = next ? next[1] : target;
			continue;
		}
		const length = Math.min(span, room);
		const { trackId: _taken, ...rest } = layer;
		added.push({
			...rest,
			id: createId("layer"),
			startSec: round3(start),
			outSec: round3(layer.inSec + length),
			fadeOutSec: round3(Math.min(layer.fadeOutSec, length)),
			fadeInSec: round3(Math.min(layer.fadeInSec, length)),
		});
		cursor = start + length;
	}
	if (added.length === 0) return { document, count: 0 };
	return {
		document: withBoard(document, { ...board, layers: [...layers, ...added] }),
		count: added.length,
	};
}

/** Mutes or unmutes every clip on a row. */
export function setRowMuted(document: AxcutDocument, row: number, muted: boolean): AxcutDocument {
	const board = audioBoardOf(document);
	const layers = withRows(board.layers);
	if (!layers.some((layer) => layerRow(layer) === row && layer.muted !== muted)) return document;
	return withBoard(document, {
		...board,
		layers: layers.map((layer) => (layerRow(layer) === row ? { ...layer, muted } : layer)),
	});
}

/** Takes a clip off the timeline. Its file stays in the library, to be placed again. */
export function removeLayer(document: AxcutDocument, id: string): AxcutDocument {
	const board = audioBoardOf(document);
	const layer = board.layers.find((entry) => entry.id === id);
	if (!layer) return document;
	return withBoard(document, {
		...board,
		layers: compactRows(withRows(board.layers).filter((entry) => entry.id !== id)),
		library: withLibrary(board, [{ assetId: layer.assetId, kind: layer.kind }]),
	});
}

/**
 * Removes a file from the library: every clip of it, the programme tracks that play it and the
 * file itself, with its transcript. The applied mix stays until the board is applied again.
 */
export function removeLibrarySource(document: AxcutDocument, assetId: string): AxcutDocument {
	const board = audioBoardOf(document);
	if (assetId === board.mix?.assetId) return document;
	const asset = document.assets.find((entry) => entry.id === assetId);
	if (!asset || asset.kind !== "audio") return document;
	const layers = board.layers.filter((layer) => layer.assetId !== assetId);
	return {
		...withBoard(document, {
			...board,
			layers: compactRows(layers),
			library: (board.library ?? []).filter((entry) => entry.assetId !== assetId),
		}),
		audioTracks: document.audioTracks.filter((track) => track.assetId !== assetId),
		assets: document.assets.filter((entry) => entry.id !== assetId),
		transcripts: document.transcripts.filter((transcript) => transcript.assetId !== assetId),
	};
}

/**
 * Drops the given mix files, with their transcripts, once nothing plays or holds them. Only mix
 * files: a file the user imported stays in the library even when no clip uses it.
 */
function dropOrphanMixes(document: AxcutDocument, assetIds: string[]): AxcutDocument {
	const board = audioBoardOf(document);
	const held = new Set([
		...document.timeline.clips.map((clip) => clip.assetId),
		...document.audioTracks.map((track) => track.assetId),
		...board.layers.map((layer) => layer.assetId),
		...(board.library ?? []).map((entry) => entry.assetId),
		...(board.mix ? [board.mix.assetId] : []),
	]);
	const doomed = new Set(
		assetIds.filter(
			(id) =>
				!held.has(id) && document.assets.some((asset) => asset.id === id && asset.kind === "audio"),
		),
	);
	if (doomed.size === 0) return document;
	return {
		...document,
		assets: document.assets.filter((asset) => !doomed.has(asset.id)),
		transcripts: document.transcripts.filter((transcript) => !doomed.has(transcript.assetId)),
	};
}

/**
 * Every programme audio track not yet on the board becomes a layer, so what the programme plays
 * is what the Audio tab shows before anything is mixed. The applied mix is not a layer, and a
 * track is taken only once.
 */
export function adoptProgrammeTracks(document: AxcutDocument): AxcutDocument {
	const board = audioBoardOf(document);
	const taken = new Set(board.layers.map((layer) => layer.trackId));
	const pills = collapseTracksToPills(document.audioTracks).filter(
		(pill) => pill.assetId !== board.mix?.assetId && !taken.has(trackGroupId(pill)),
	);
	if (pills.length === 0) return document;
	const existing = withRows(board.layers);
	let row = Math.max(-1, ...existing.map(layerRow)) + 1;
	const adopted = pills.map((pill): AxcutAudioBoardLayer => {
		const asset = document.assets.find((entry) => entry.id === pill.assetId);
		const inSec = pill.offsetMs / 1000;
		const spanSec = Math.max(MIN_LAYER_SEC, (pill.endMs - pill.startMs) / 1000);
		const sourceSec = asset?.durationSec || pill.durationSec || inSec + spanSec;
		return {
			id: createId("layer"),
			assetId: pill.assetId,
			kind: pill.kind,
			label: pill.label || asset?.label || "",
			startSec: round3(pill.startMs / 1000),
			inSec: round3(inSec),
			outSec: round3(Math.max(inSec + MIN_LAYER_SEC, Math.min(sourceSec, inSec + spanSec))),
			volume: volumeFromGainDb(pill.gainDb),
			fadeInSec: round3(pill.fadeInMs / 1000),
			fadeOutSec: round3(pill.fadeOutMs / 1000),
			muted: pill.muted,
			trackId: trackGroupId(pill),
			row: row++,
		};
	});
	return withBoard(document, { ...board, layers: [...existing, ...adopted] });
}

export interface MixLayerSpec {
	path: string;
	startSec: number;
	inSec: number;
	outSec: number;
	/** Linear: volume / 100. */
	gain: number;
	fadeInSec: number;
	fadeOutSec: number;
}

export interface MixSpec {
	layers: MixLayerSpec[];
	durationSec: number;
}

/** What the mixer is asked for: every layer that makes a sound, by its file. Null when none does. */
export function mixSpec(document: AxcutDocument | null): MixSpec | null {
	if (!document) return null;
	const layers: MixLayerSpec[] = [];
	for (const layer of audioBoardOf(document).layers.filter(isAudible)) {
		const asset = document.assets.find((entry) => entry.id === layer.assetId);
		if (!asset) continue;
		// Fades that overrun the layer share it in proportion, as they do everywhere else.
		const fades = resolveFadeSecs(
			layer.fadeInSec * 1000,
			layer.fadeOutSec * 1000,
			layerSpanSec(layer),
		);
		layers.push({
			path: asset.originalPath,
			startSec: layer.startSec,
			inSec: layer.inSec,
			outSec: layer.outSec,
			gain: layer.volume / 100,
			fadeInSec: round3(fades.fadeInSec),
			fadeOutSec: round3(fades.fadeOutSec),
		});
	}
	if (layers.length === 0) return null;
	const durationSec = round3(
		Math.max(...layers.map((layer) => layer.startSec + layer.outSec - layer.inSec)),
	);
	return { layers, durationSec };
}

/** What a mix was made from, as a string: equal strings, the same sound. */
export function mixSignature(spec: MixSpec | null): string {
	return spec ? JSON.stringify(spec) : "";
}

export type MixStatus = "empty" | "unapplied" | "changed" | "applied";

/**
 * `empty`: no layer makes a sound. `unapplied`: the programme does not play the board's mix.
 * `changed`: it does, but the layers changed since. `applied`: it plays exactly these layers.
 */
export function mixStatus(document: AxcutDocument | null): MixStatus {
	const spec = mixSpec(document);
	if (!document || !spec) return "empty";
	const mix = audioBoardOf(document).mix;
	if (!mix || !document.audioTracks.some((track) => track.assetId === mix.assetId))
		return "unapplied";
	return mix.signature === mixSignature(spec) ? "applied" : "changed";
}

/** True when the programme's audio is the board's mix. */
export function playsBoardMix(document: AxcutDocument | null): boolean {
	const mix = audioBoardOf(document).mix;
	return Boolean(mix && document?.audioTracks.some((track) => track.assetId === mix.assetId));
}

export interface AppliedMix {
	assetId: string;
	durationSec: number;
	signature: string;
}

/**
 * The programme plays the mix alone, from 0 and on the programme clock, in one edit. A mix with
 * narration in it is narration to the rest of the app — captions and Media's cuts on pauses read
 * it — so it carries the narration layers' words where it plays them. Tracks the board had not
 * taken yet are taken first, so nothing the programme played goes missing unseen. The mix it
 * replaces is dropped; the files the clips play stay in the library.
 */
export function applyMix(document: AxcutDocument, mix: AppliedMix): AxcutDocument {
	const adopted = adoptProgrammeTracks(document);
	const board = audioBoardOf(adopted);
	const narration = board.layers.some((layer) => layer.kind === "voiceover" && isAudible(layer));
	const track: AxcutAudioTrack = {
		...createAudioTrack({
			assetId: mix.assetId,
			durationSec: mix.durationSec,
			kind: narration ? "voiceover" : "music",
			label: MIX_LABEL,
		}),
		timelineLocked: true,
	};
	const isMix = (id: string) =>
		id === board.mix?.assetId ||
		adopted.assets.some((asset) => asset.id === id && isMixFile(asset));
	const replaced = [
		...adopted.audioTracks.map((entry) => entry.assetId),
		...(board.mix ? [board.mix.assetId] : []),
	].filter((id) => id !== mix.assetId && isMix(id));
	const next = withMixTranscript(
		withBoard(
			{ ...adopted, audioTracks: [track] },
			{ ...board, mix: { assetId: mix.assetId, signature: mix.signature } },
		),
		mix.assetId,
		board.mix?.assetId,
	);
	return dropOrphanMixes(next, replaced);
}

/**
 * The narration layers' words where the mix plays them. Only when every narration layer that
 * makes a sound has its transcript; otherwise the mix is left to be transcribed like any
 * narration, and a transcript it already has is kept. A word corrected on the previous mix keeps
 * its correction: its id names the layer and the word, which a new mix of them names again.
 */
function withMixTranscript(
	document: AxcutDocument,
	mixAssetId: string,
	previousAssetId: string | undefined,
): AxcutDocument {
	const layers = audioBoardOf(document).layers.filter(
		(layer) => layer.kind === "voiceover" && isAudible(layer),
	);
	const sources = layers.map((layer) => ({
		layer,
		transcript: findAssetTranscript(document, layer.assetId),
	}));
	if (sources.length === 0 || sources.some((source) => !source.transcript)) return document;
	const words: AxcutTranscript["words"] = [];
	const segments: AxcutTranscript["segments"] = [];
	let language = "";
	for (const { layer, transcript } of sources) {
		if (!transcript) continue;
		language ||= transcript.language;
		const shift = layer.startSec - layer.inSec;
		const plays = (start: number, end: number) => end > layer.inSec && start < layer.outSec;
		const toMix = (sec: number) => round3(clamp(sec + shift, layer.startSec, layerEndSec(layer)));
		const prefix = `${layer.id}:`;
		const kept = new Set<string>();
		for (const word of transcript.words) {
			if (!plays(word.startSec, word.endSec)) continue;
			kept.add(word.id);
			words.push({
				...word,
				id: prefix + word.id,
				segmentId: prefix + word.segmentId,
				startSec: toMix(word.startSec),
				endSec: toMix(word.endSec),
			});
		}
		for (const segment of transcript.segments) {
			if (!plays(segment.startSec, segment.endSec)) continue;
			segments.push({
				...segment,
				id: prefix + segment.id,
				startSec: toMix(segment.startSec),
				endSec: toMix(segment.endSec),
				wordIds: segment.wordIds.filter((id) => kept.has(id)).map((id) => prefix + id),
			});
		}
	}
	const byStart = (left: { startSec: number }, right: { startSec: number }) =>
		left.startSec - right.startSec;
	let transcript: AxcutTranscript = {
		assetId: mixAssetId,
		language: language || "auto",
		segments: segments.sort(byStart),
		words: words.sort(byStart),
	};
	const previous = previousAssetId ? findAssetTranscript(document, previousAssetId) : null;
	for (const edit of previous?.words ?? []) {
		if (edit.source !== "user" || !transcript.words.some((word) => word.id === edit.id)) continue;
		try {
			transcript = setWordText(transcript, edit.id, edit.text);
		} catch {
			// A word whose segment no longer holds it together keeps the narration's text.
		}
	}
	return {
		...document,
		transcripts: [
			...document.transcripts.filter((entry) => entry.assetId !== mixAssetId),
			transcript,
		],
	};
}

/**
 * A layer as the audio track the preview's player already knows how to play: its span, its
 * offset into the file and its fades. The layer's volume is applied by the caller.
 */
export function layerAsTrack(
	layer: AxcutAudioBoardLayer,
	sourceDurationSec: number | undefined,
): AxcutAudioTrack {
	return {
		id: layer.id,
		assetId: layer.assetId,
		kind: layer.kind,
		startMs: Math.round(layer.startSec * 1000),
		endMs: Math.round(layerEndSec(layer) * 1000),
		offsetMs: Math.round(layer.inSec * 1000),
		durationSec: sourceDurationSec ?? layer.outSec,
		gainDb: 0,
		loop: false,
		fadeInMs: Math.round(layer.fadeInSec * 1000),
		fadeOutMs: Math.round(layer.fadeOutSec * 1000),
		muted: layer.muted,
		label: layer.label,
		origin: "user",
	};
}
