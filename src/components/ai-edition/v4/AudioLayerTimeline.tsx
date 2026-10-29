import { Headphones, Layers, Music2, Plus, Volume2, VolumeX } from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAudioPeaks } from "@/hooks/useAudioPeaks";
import type { AxcutAudioBoardLayer } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	boardEndSec,
	boardRows,
	type LayerPatch,
	layerEndSec,
	layerRow,
	layerSpanSec,
	MIN_LAYER_SEC,
	rowKind,
} from "@/lib/audio-board/board";
import styles from "./AudioLayerTimeline.module.css";
import { useTimelineZoom, ZoomControls } from "./TimelineZoom";

/**
 * The Audio tab's timeline: tracks (rows) of clips. Drag a clip to move it — along its row, or
 * onto another row — drag its edges to trim the file it plays, click the ruler to move the
 * playhead, and drop a clip from the library onto a row to place it there. Clips on a row never
 * overlap; edges snap to the start, the playhead and the other clips' edges, so narrations line
 * up back to back. A drag is shown live through `onLive` and written once, on release, through
 * `onCommit`.
 */

export interface LayerSource {
	label: string;
	url?: string;
	durationSec?: number;
}

/** What a library card carries when it is dragged onto the timeline: its file's asset id. */
export const AUDIO_SOURCE_MIME = "application/x-donqui-audio-source";

type DragMode = "move" | "in" | "out";

interface Drag {
	id: string;
	mode: DragMode;
	startX: number;
	startY: number;
	secPerPx: number;
	layer: AxcutAudioBoardLayer;
	patch: LayerPatch | null;
}

const SNAP_PX = 8;
/** From one row to the next: a lane's 46 px and its 1 px border, as the heads have too
 *  (AudioLayerTimeline.module.css). */
const ROW_PITCH_PX = 47;
/** How far a clip must be dragged up or down before it changes rows. */
const ROW_DRAG_PX = 14;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The target nearest `value` within `threshold`, or null. */
function nearestSnap(value: number, targets: number[], threshold: number): number | null {
	let best: number | null = null;
	for (const target of targets) {
		const gap = Math.abs(target - value);
		if (gap <= threshold && (best === null || gap < Math.abs(best - value))) best = target;
	}
	return best;
}

/**
 * The layer as `mode` drags it by `deltaSec`: moved whole, or trimmed at one edge — the in-point
 * moving the start with it, so what plays stays where it was — kept inside its file and at least
 * MIN_LAYER_SEC long. The dragged edge snaps to `targets` within `snapSec`; a moved layer snaps
 * by whichever of its edges is nearer one.
 */
export function draggedLayer(
	layer: AxcutAudioBoardLayer,
	mode: DragMode,
	deltaSec: number,
	sourceDurationSec: number | undefined,
	targets: number[] = [],
	snapSec = 0,
): LayerPatch {
	if (mode === "move") {
		const span = layerSpanSec(layer);
		const raw = Math.max(0, layer.startSec + deltaSec);
		const head = nearestSnap(raw, targets, snapSec);
		const tail = nearestSnap(raw + span, targets, snapSec);
		let startSec = raw;
		if (head !== null && (tail === null || Math.abs(head - raw) <= Math.abs(tail - raw - span)))
			startSec = head;
		else if (tail !== null) startSec = tail - span;
		return { startSec: round3(Math.max(0, startSec)) };
	}
	if (mode === "in") {
		const low = -Math.min(layer.inSec, layer.startSec);
		const high = layer.outSec - MIN_LAYER_SEC - layer.inSec;
		const bounded = (delta: number) => Math.min(high, Math.max(low, delta));
		const raw = layer.startSec + bounded(deltaSec);
		const delta = bounded((nearestSnap(raw, targets, snapSec) ?? raw) - layer.startSec);
		return { startSec: round3(layer.startSec + delta), inSec: round3(layer.inSec + delta) };
	}
	const limit =
		sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec : Number.POSITIVE_INFINITY;
	const rawEnd = layerEndSec(layer) + deltaSec;
	const endSec = nearestSnap(rawEnd, targets, snapSec) ?? rawEnd;
	const outSec = Math.min(
		limit,
		Math.max(layer.inSec + MIN_LAYER_SEC, layer.inSec + endSec - layer.startSec),
	);
	return { outSec: round3(outSec) };
}

const KIND_LABEL = { music: "음악", voiceover: "나레이션" } as const;

export function AudioLayerTimeline({
	layers,
	sources,
	selectedId,
	onSelect,
	onLive,
	onCommit,
	onDropSource,
	onRowMute,
}: {
	/** Every clip, with its row. */
	layers: AxcutAudioBoardLayer[];
	sources: (layer: AxcutAudioBoardLayer) => LayerSource;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onLive: (id: string, patch: LayerPatch) => void;
	onCommit: (id: string, patch: LayerPatch) => void;
	/** A library file dropped on `row` at `atSec`. */
	onDropSource: (assetId: string, row: number, atSec: number) => void;
	onRowMute: (row: number, muted: boolean) => void;
}) {
	const [widthPx, setWidthPx] = useState(0);
	const scroller = useRef<HTMLDivElement>(null);
	const lanes = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const [frozenViewSec, setFrozenViewSec] = useState<number | null>(null);
	const [dropRow, setDropRow] = useState<number | null>(null);
	// The rows as they were when a drag began. A clip dragged off a row it had to itself would
	// otherwise close that row up under the pointer and send the clip on to the next.
	const [frozenRows, setFrozenRows] = useState<number[] | null>(null);
	const zoom = useTimelineZoom(scroller);

	const rows = frozenRows ?? boardRows(layers);
	const newRow = (rows.at(-1) ?? -1) + 1;
	const rowIndex = (layer: AxcutAudioBoardLayer) => {
		const index = rows.indexOf(layerRow(layer));
		return index < 0 ? rows.length : index;
	};
	const selectedRow = layers.find((layer) => layer.id === selectedId);

	// Some room past the last clip to drag into; the view holds still while a drag is on.
	const liveViewSec = Math.max(10, Math.ceil(boardEndSec(layers) * 1.15 + 1));
	const viewSec = frozenViewSec ?? liveViewSec;

	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const measure = () => setWidthPx(element.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const pxPerSec = (widthPx * zoom.zoom) / viewSec;
	const tickStep = TICK_STEPS.find((step) => step * pxPerSec >= 64) ?? TICK_STEPS.at(-1) ?? 60;
	const ticks = useMemo(() => {
		const list: number[] = [];
		for (let sec = 0; sec <= viewSec + 1e-9; sec += tickStep) list.push(round3(sec));
		return list;
	}, [viewSec, tickStep]);
	const pct = (sec: number) => `${(sec / viewSec) * 100}%`;

	const secAt = (clientX: number) => {
		const rect = lanes.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || !Number.isFinite(clientX)) return 0;
		return Math.max(0, ((clientX - rect.left) / rect.width) * viewSec);
	};

	/** The row under a pointer: a lane's own, or a new one below the last. */
	const rowAt = (clientY: number): number | null => {
		const lanesEl = Array.from(lanes.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
		for (const lane of lanesEl) {
			const rect = lane.getBoundingClientRect();
			if (clientY >= rect.top && clientY < rect.bottom) return Number(lane.dataset.row);
		}
		const last = lanesEl.at(-1)?.getBoundingClientRect();
		return last && clientY >= last.bottom ? newRow : null;
	};

	const seek = (event: ReactPointerEvent<HTMLElement>) => {
		const state = useProjectStore.getState();
		state.setCurrentTime(Math.min(secAt(event.clientX), Math.max(0, boardEndSec(layers))));
	};

	const startDrag = (
		event: ReactPointerEvent<HTMLElement>,
		layer: AxcutAudioBoardLayer,
		mode: DragMode,
	) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		const rect = lanes.current?.getBoundingClientRect();
		const width = rect && rect.width > 0 ? rect.width : widthPx * zoom.zoom;
		drag.current = {
			id: layer.id,
			mode,
			startX: event.clientX,
			startY: event.clientY,
			secPerPx: width > 0 ? viewSec / width : 0,
			layer,
			patch: null,
		};
		setFrozenViewSec(viewSec);
		setFrozenRows(rows);
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};

	const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current || current.secPerPx <= 0) return;
		const dx = event.clientX - current.startX;
		const dy = event.clientY - current.startY;
		if (current.patch === null && Math.abs(dx) < 3 && Math.abs(dy) < ROW_DRAG_PX) return;
		const targets = [
			0,
			useProjectStore.getState().currentTimeSec,
			...layers
				.filter((layer) => layer.id !== current.id)
				.flatMap((layer) => [layer.startSec, layerEndSec(layer)]),
		];
		const patch = draggedLayer(
			current.layer,
			current.mode,
			dx * current.secPerPx,
			sources(current.layer).durationSec,
			targets,
			SNAP_PX * current.secPerPx,
		);
		if (current.mode === "move" && Math.abs(dy) >= ROW_DRAG_PX) {
			const row = rowAt(event.clientY);
			if (row !== null && row !== layerRow(current.layer)) patch.row = row;
		}
		current.patch = patch;
		onLive(current.id, patch);
	};

	const endDrag = () => {
		const current = drag.current;
		drag.current = null;
		setFrozenViewSec(null);
		setFrozenRows(null);
		if (!current) return;
		if (current.patch) onCommit(current.id, current.patch);
	};

	const nudge = (layer: AxcutAudioBoardLayer, key: string, shift: boolean) => {
		const step = (shift ? 1 : 0.1) * (key === "ArrowLeft" ? -1 : 1);
		onSelect(layer.id);
		onCommit(layer.id, { startSec: round3(Math.max(0, layer.startSec + step)) });
	};

	const acceptsDrop = (event: ReactDragEvent<HTMLElement>) =>
		Array.from(event.dataTransfer?.types ?? []).includes(AUDIO_SOURCE_MIME);

	const laneDropProps = (row: number) => ({
		onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
			if (!acceptsDrop(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			if (dropRow !== row) setDropRow(row);
		},
		onDragLeave: () => setDropRow((current) => (current === row ? null : current)),
		onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
			const assetId = event.dataTransfer.getData(AUDIO_SOURCE_MIME);
			setDropRow(null);
			if (!assetId) return;
			event.preventDefault();
			onDropSource(assetId, row, secAt(event.clientX));
		},
	});

	return (
		<section className={styles.timeline} aria-label="오디오 타임라인">
			<div className={styles.toolbar}>
				<span className={styles.title}>
					트랙 {rows.length}개 · 클립 {layers.length}개
				</span>
				<span className={styles.hint}>
					클립을 끌어 옮기고(위아래로 끌면 다른 트랙), 양 끝을 끌어 자르세요. 왼쪽 목록의 클립을
					끌어다 놓아도 됩니다.
				</span>
				<ZoomControls zoom={zoom} />
			</div>
			<div className={styles.body}>
				<div className={styles.heads}>
					<div className={styles.rulerSpacer} />
					{rows.map((row, index) => {
						const kind = rowKind(layers, row);
						const clips = layers.filter((layer) => layerRow(layer) === row);
						const muted = clips.length > 0 && clips.every((layer) => layer.muted);
						const name = `트랙 ${index + 1}`;
						return (
							<div
								key={row}
								className={styles.head}
								data-selected={selectedRow !== undefined && layerRow(selectedRow) === row}
							>
								{kind === "music" ? (
									<Music2 size={14} />
								) : kind === "voiceover" ? (
									<Headphones size={14} />
								) : (
									<Layers size={14} />
								)}
								<span className={styles.headLabel} title={name}>
									{name}
									<small>
										{kind ? KIND_LABEL[kind] : "혼합"} · {clips.length}개
									</small>
								</span>
								<button
									type="button"
									className={styles.mute}
									aria-label={`${name} 음소거`}
									aria-pressed={muted}
									onClick={() => onRowMute(row, !muted)}
								>
									{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
								</button>
							</div>
						);
					})}
					<div className={`${styles.head} ${styles.newHead}`}>
						<Plus size={13} />
						<span className={styles.headLabel}>새 트랙</span>
					</div>
				</div>
				<div className={styles.scroller} ref={scroller}>
					<div className={styles.canvas} ref={lanes} style={{ width: `${zoom.zoom * 100}%` }}>
						<div
							className={styles.ruler}
							data-testid="audio-ruler"
							onPointerDown={(event) => {
								seek(event);
								event.currentTarget.setPointerCapture?.(event.pointerId);
							}}
							onPointerMove={(event) => {
								if (event.buttons & 1) seek(event);
							}}
						>
							{ticks.map((sec) => (
								<span key={sec} className={styles.tick} style={{ left: pct(sec) }}>
									{formatSeconds(sec)}
								</span>
							))}
						</div>
						<div className={styles.rows}>
							{rows.map((row) => (
								<div
									key={row}
									className={styles.lane}
									data-row={row}
									data-drop={dropRow === row}
									onPointerDown={() => onSelect(null)}
									{...laneDropProps(row)}
								/>
							))}
							<div
								className={`${styles.lane} ${styles.newLane}`}
								data-row={newRow}
								data-drop={dropRow === newRow}
								onPointerDown={() => onSelect(null)}
								{...laneDropProps(newRow)}
							>
								<span className={styles.newLaneHint}>여기로 끌어다 놓으면 새 트랙에 놓입니다</span>
							</div>
							{/* One layer of clips over the lanes rather than clips inside them: a clip
							    dragged to another row only changes its `top`, so the element — and the
							    pointer capture it holds — survives the move. */}
							{layers.map((layer) => {
								const source = sources(layer);
								const span = layerSpanSec(layer);
								return (
									<div
										key={layer.id}
										role="button"
										tabIndex={0}
										aria-label={`${source.label} 클립`}
										aria-pressed={layer.id === selectedId}
										className={styles.pill}
										data-kind={layer.kind}
										data-muted={layer.muted}
										data-missing={!source.url}
										style={{
											left: pct(layer.startSec),
											width: pct(span),
											top: rowIndex(layer) * ROW_PITCH_PX + 5,
											height: ROW_PITCH_PX - 11,
										}}
										onPointerDown={(event) => startDrag(event, layer, "move")}
										onClick={() => onSelect(layer.id)}
										onPointerMove={moveDrag}
										onPointerUp={endDrag}
										onPointerCancel={endDrag}
										onKeyDown={(event) => {
											if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
												event.preventDefault();
												nudge(layer, event.key, event.shiftKey);
											} else if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												onSelect(layer.id);
											}
										}}
									>
										<LayerWaveform
											url={source.url}
											durationSec={source.durationSec}
											inSec={layer.inSec}
											outSec={layer.outSec}
											gain={layer.volume / 100}
										/>
										{layer.fadeInSec > 0 ? (
											<span
												className={styles.fadeIn}
												style={{ width: `${Math.min(100, (layer.fadeInSec / span) * 100)}%` }}
											/>
										) : null}
										{layer.fadeOutSec > 0 ? (
											<span
												className={styles.fadeOut}
												style={{ width: `${Math.min(100, (layer.fadeOutSec / span) * 100)}%` }}
											/>
										) : null}
										<span className={styles.pillLabel}>
											{source.label} · {formatSeconds(span)}
											{layer.volume !== 100 ? ` · ${layer.volume}%` : ""}
										</span>
										<span
											className={styles.handle}
											data-edge="in"
											aria-label="앞부분 자르기"
											onPointerDown={(event) => startDrag(event, layer, "in")}
										/>
										<span
											className={styles.handle}
											data-edge="out"
											aria-label="뒷부분 자르기"
											onPointerDown={(event) => startDrag(event, layer, "out")}
										/>
									</div>
								);
							})}
						</div>
						<Playhead viewSec={viewSec} />
					</div>
				</div>
			</div>
		</section>
	);
}

/** Subscribes to the clock on its own, so playback moves one line instead of every row. */
function Playhead({ viewSec }: { viewSec: number }) {
	const time = useProjectStore((state) => state.currentTimeSec);
	return (
		<div
			className={styles.playhead}
			style={{ left: `${(Math.min(time, viewSec) / viewSec) * 100}%` }}
			aria-hidden
		/>
	);
}

/** The stretch of the file the layer plays, at its volume, clipped where the mix would clip. */
export function LayerWaveform({
	url,
	durationSec,
	inSec,
	outSec,
	gain,
}: {
	url?: string;
	durationSec?: number;
	inSec: number;
	outSec: number;
	gain: number;
}) {
	const peaks = useAudioPeaks(url, durationSec);
	const bars = useMemo(() => {
		if (!peaks || peaks.length === 0 || !durationSec) return null;
		const blocks = Math.floor(peaks.length / 2);
		if (blocks === 0) return null;
		const perSec = blocks / durationSec;
		const first = Math.max(0, Math.floor(inSec * perSec));
		const last = Math.min(blocks, Math.ceil(outSec * perSec));
		const range = Math.max(1, last - first);
		const count = Math.min(400, Math.max(16, Math.round((outSec - inSec) * 8)));
		const result: number[] = [];
		for (let index = 0; index < count; index++) {
			const from = first + Math.floor((index / count) * range);
			const to = Math.max(from + 1, first + Math.floor(((index + 1) / count) * range));
			let amplitude = 0;
			for (let block = from; block < to && block < blocks; block++)
				amplitude = Math.max(
					amplitude,
					Math.abs(peaks[block * 2] ?? 0),
					Math.abs(peaks[block * 2 + 1] ?? 0),
				);
			result.push(amplitude);
		}
		return result;
	}, [peaks, durationSec, inSec, outSec]);
	if (!bars) return null;
	return (
		<div className={styles.wave} aria-hidden>
			{bars.map((amplitude, index) => {
				const level = Math.min(1, amplitude * gain);
				return <span key={index} style={{ height: `${Math.max(6, Math.round(level * 100))}%` }} />;
			})}
		</div>
	);
}
