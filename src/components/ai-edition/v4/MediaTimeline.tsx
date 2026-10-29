import {
	AlertTriangle,
	AudioLines,
	Check,
	Film,
	Image as ImageIcon,
	WandSparkles,
} from "lucide-react";
import {
	type CSSProperties,
	type DragEvent as ReactDragEvent,
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type {
	AxcutAsset,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { clipEffectLabel } from "@/lib/media-board/apply";
import { itemDurationSec, itemEffect, resolvedItemEffect } from "@/lib/media-board/board";
import { itemFitSlot, itemWithDuration, type Span } from "@/lib/media-board/fit";
import { useMediaPreview } from "@/lib/media-board/preview";
import { useThumbnail } from "@/lib/media-board/thumbnails";
import {
	compositionSec,
	insertIndexAt,
	itemStarts,
	type MediaAudioClip,
	snapTo,
	trimmedHead,
} from "@/lib/media-board/timeline";
import { LayerWaveform } from "./AudioLayerTimeline";
import styles from "./MediaTimeline.module.css";
import { useTimelineZoom, ZoomControls } from "./TimelineZoom";

/** What a library card carries when it is dragged onto the timeline. */
export const MEDIA_MATERIAL_MIME = "application/x-donqui-media";

export interface MaterialPayload {
	kind: "clip" | "photo" | "video";
	id: string;
}

export function parseMaterial(value: string): MaterialPayload | null {
	try {
		const parsed = JSON.parse(value) as Partial<MaterialPayload>;
		return (parsed.kind === "clip" || parsed.kind === "photo" || parsed.kind === "video") &&
			typeof parsed.id === "string"
			? { kind: parsed.kind, id: parsed.id }
			: null;
	} catch {
		return null;
	}
}

export type AudioState = "applied" | "changed" | "unapplied" | "empty";

type DragMode = "move" | "start" | "end";

interface Drag {
	id: string;
	mode: DragMode;
	startX: number;
	secPerPx: number;
	moved: boolean;
}

const SNAP_PX = 8;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Media's timeline, docked under the page: the soundtrack on the top row — the Audio tab's mix,
 * with the narration's words and pauses marked — and the composition on the row below, its
 * clips, videos and photos one after another. Drag an item to change its place, drag its right
 * edge to change its length (the end snaps to the pauses, the playhead and the audio's end),
 * its left edge to trim its head, and drop material from the library where it should go.
 */
export function MediaTimeline({
	items,
	images,
	assets,
	audio,
	audioSec,
	speech,
	pauses,
	audioState,
	selectedId,
	locked,
	sourceDuration,
	onSelect,
	onResize,
	onMove,
	onDropMaterial,
	fit,
}: {
	items: AxcutMediaBoardItem[];
	images: AxcutMediaBoardImage[];
	assets: AxcutAsset[];
	audio: MediaAudioClip[];
	audioSec: number;
	speech: Span[];
	pauses: number[];
	audioState: AudioState;
	selectedId: string | null;
	/** While the composition is being applied nothing on it changes. */
	locked: boolean;
	sourceDuration: (item: Pick<AxcutMediaBoardItem, "assetId">) => number | undefined;
	onSelect: (id: string | null) => void;
	onResize: (id: string, range: { startSec: number; endSec: number }) => void;
	onMove: (id: string, toIndex: number) => void;
	onDropMaterial: (payload: MaterialPayload, index: number) => void;
	fit: {
		onFit: () => void;
		snap: boolean;
		onSnap: (value: boolean) => void;
		pauseCount: number;
	};
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLDivElement>(null);
	const zoom = useTimelineZoom(scroller);
	const [widthPx, setWidthPx] = useState(0);
	const drag = useRef<Drag | null>(null);
	const [live, setLive] = useState<{ id: string; mode: DragMode; deltaSec: number } | null>(null);
	const [frozenViewSec, setFrozenViewSec] = useState<number | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);

	const totalSec = compositionSec(items);
	const audioEnd = Math.max(audioSec, ...audio.map((clip) => clip.endSec));
	const liveViewSec = Math.max(10, Math.ceil(Math.max(audioEnd, totalSec) * 1.1 + 1));
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
		const rect = canvas.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || !Number.isFinite(clientX)) return 0;
		return Math.max(0, ((clientX - rect.left) / rect.width) * viewSec);
	};

	// ── The composition as it is drawn, a drag in progress included ──────
	const starts = itemStarts(items);
	const liveItem = live ? items.find((item) => item.id === live.id) : undefined;
	/** The range a drag leaves an item with, in source seconds. */
	const draggedRange = (item: AxcutMediaBoardItem, mode: DragMode, deltaSec: number) => {
		if (mode === "start") return trimmedHead(item, deltaSec);
		const index = items.indexOf(item);
		const slot = itemFitSlot(item, sourceDuration(item));
		const rawEnd = starts[index] + itemDurationSec(item) + deltaSec;
		const targets = [audioEnd, ...pauses, useMediaPreview.getState().timeSec];
		const end = snapTo(rawEnd, targets, pxPerSec > 0 ? SNAP_PX / pxPerSec : 0);
		const durationSec = Math.min(slot.maxSec, Math.max(slot.minSec, end - starts[index]));
		return itemWithDuration(item, round3(durationSec), sourceDuration(item));
	};
	const durations = items.map((item) =>
		liveItem === item && live?.mode === "end"
			? itemDurationSec(draggedRange(item, "end", live.deltaSec))
			: itemDurationSec(item),
	);
	const shownStarts = cumulative(durations);
	const moveIndex =
		live?.mode === "move" && liveItem
			? insertIndexAt(
					items,
					starts[items.indexOf(liveItem)] + itemDurationSec(liveItem) / 2 + live.deltaSec,
					liveItem.id,
				)
			: null;

	// ── Pointer ─────────────────────────────────────────────────────────
	const seek = (clientX: number) => useMediaPreview.getState().seekTo(secAt(clientX));

	const startDrag = (
		event: ReactPointerEvent<HTMLElement>,
		item: AxcutMediaBoardItem,
		mode: DragMode,
	) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		const rect = canvas.current?.getBoundingClientRect();
		const width = rect && rect.width > 0 ? rect.width : widthPx * zoom.zoom;
		drag.current = {
			id: item.id,
			mode,
			startX: event.clientX,
			secPerPx: width > 0 ? viewSec / width : 0,
			moved: false,
		};
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};

	const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current || locked) return;
		const dx = event.clientX - current.startX;
		if (!current.moved && Math.abs(dx) < 3) return;
		if (!current.moved) {
			current.moved = true;
			setFrozenViewSec(viewSec);
		}
		setLive({ id: current.id, mode: current.mode, deltaSec: dx * current.secPerPx });
	};

	const endDrag = () => {
		const current = drag.current;
		drag.current = null;
		const shown = live;
		setLive(null);
		setFrozenViewSec(null);
		if (!current) return;
		const item = items.find((entry) => entry.id === current.id);
		if (!item) return;
		if (!current.moved) {
			// A click: select it, and show it in the preview.
			onSelect(item.id);
			useMediaPreview.getState().seekTo(starts[items.indexOf(item)] + 0.001);
			return;
		}
		if (!shown || locked) return;
		if (current.mode === "move") {
			const to = insertIndexAt(
				items,
				starts[items.indexOf(item)] + itemDurationSec(item) / 2 + shown.deltaSec,
				item.id,
			);
			if (to !== items.indexOf(item)) onMove(item.id, to);
		} else {
			const range = draggedRange(item, current.mode, shown.deltaSec);
			if (range.startSec !== item.startSec || range.endSec !== item.endSec)
				onResize(item.id, range);
		}
		onSelect(item.id);
	};

	// ── Drops from the library ──────────────────────────────────────────
	const accepts = (event: ReactDragEvent<HTMLElement>) =>
		Array.from(event.dataTransfer?.types ?? []).includes(MEDIA_MATERIAL_MIME);

	const difference = audioSec - totalSec;
	const tone =
		audioSec <= 0 || items.length === 0 ? "none" : Math.abs(difference) < 0.05 ? "ok" : "off";

	return (
		<section className={styles.timeline} aria-label="Media 타임라인">
			<div className={styles.toolbar}>
				<span className={styles.title}>Media 타임라인</span>
				<span className={styles.summary}>
					Audio <strong>{formatSeconds(audioSec)}</strong> · 영상·사진{" "}
					<strong>{formatSeconds(totalSec)}</strong>
					{tone === "ok" ? (
						<span data-tone="ok">
							<Check size={12} /> 길이가 맞습니다
						</span>
					) : tone === "off" ? (
						<span data-tone="off">
							{difference > 0
								? `${formatSeconds(difference)} 모자람`
								: `${formatSeconds(-difference)} 넘침`}
						</span>
					) : null}
				</span>
				<button
					type="button"
					className={styles.fitButton}
					disabled={locked || items.length === 0 || audioSec <= 0}
					onClick={fit.onFit}
					title="항목 길이를 비율대로 늘이거나 줄여 Audio와 같이 끝나게 합니다"
				>
					<WandSparkles size={13} />
					Audio 길이에 맞추기
				</button>
				{fit.pauseCount > 0 ? (
					<label className={styles.snap}>
						<input
							type="checkbox"
							checked={fit.snap}
							onChange={(event) => fit.onSnap(event.target.checked)}
						/>
						나레이션이 쉬는 곳에 컷 맞추기 ({fit.pauseCount}곳)
					</label>
				) : null}
				<ZoomControls zoom={zoom} />
			</div>
			<div className={styles.body}>
				<div className={styles.heads}>
					<div className={styles.rulerSpacer} />
					<div className={`${styles.head} ${styles.audioHead}`}>
						<AudioLines size={14} />
						<span className={styles.headLabel}>
							Audio
							<small>
								{audioState === "applied"
									? "Media에 반영됨"
									: audioState === "changed"
										? "Audio 탭에 바뀐 내용이 있습니다"
										: audio.length > 0
											? "Edit의 오디오"
											: "아직 없음"}
							</small>
						</span>
						{audioState === "changed" ? (
							<AlertTriangle size={14} className={styles.warn} aria-label="다시 반영 필요" />
						) : null}
					</div>
					<div className={`${styles.head} ${styles.videoHead}`}>
						<Film size={14} />
						<span className={styles.headLabel}>
							영상·사진
							<small>항목 {items.length}개</small>
						</span>
					</div>
				</div>
				<div className={styles.scroller} ref={scroller}>
					<div className={styles.canvas} ref={canvas} style={{ width: `${zoom.zoom * 100}%` }}>
						<div
							className={styles.ruler}
							data-testid="media-ruler"
							onPointerDown={(event) => {
								seek(event.clientX);
								event.currentTarget.setPointerCapture?.(event.pointerId);
							}}
							onPointerMove={(event) => {
								if (event.buttons & 1) seek(event.clientX);
							}}
						>
							{ticks.map((sec) => (
								<span key={sec} className={styles.tick} style={{ left: pct(sec) }}>
									{formatSeconds(sec)}
								</span>
							))}
						</div>
						<div
							className={styles.audioLane}
							aria-label="Audio 줄"
							onPointerDown={(event) => seek(event.clientX)}
						>
							{audio.map((clip) => {
								const asset = assets.find((entry) => entry.id === clip.assetId);
								return (
									<div
										key={clip.id}
										className={styles.audioClip}
										data-kind={clip.kind}
										style={{
											left: pct(clip.startSec),
											width: pct(Math.max(0, clip.endSec - clip.startSec)),
										}}
										title={`${clip.label} · ${formatSeconds(clip.endSec - clip.startSec)}`}
									>
										<LayerWaveform
											url={asset ? toFileUrl(asset.originalPath) : undefined}
											durationSec={asset?.durationSec}
											inSec={clip.offsetSec}
											outSec={clip.offsetSec + clip.endSec - clip.startSec}
											gain={1}
										/>
										<span className={styles.audioLabel}>
											{clip.label} · {formatSeconds(clip.endSec - clip.startSec)}
										</span>
									</div>
								);
							})}
							{speech.map((part) => (
								<span
									key={`${part.startSec}-${part.endSec}`}
									className={styles.speech}
									style={{ left: pct(part.startSec), width: pct(part.endSec - part.startSec) }}
								/>
							))}
							{pauses.map((pause) => (
								<span key={pause} className={styles.pause} style={{ left: pct(pause) }} />
							))}
							{audio.length === 0 ? (
								<span className={styles.laneHint}>
									Audio 탭에서 ‘Media에 반영’을 누르면 오디오가 여기에 놓이고, 그 아래에 영상과
									사진을 맞출 수 있습니다.
								</span>
							) : null}
						</div>
						<div
							className={styles.videoLane}
							aria-label="영상·사진 줄"
							data-drop={dropIndex !== null}
							onPointerDown={(event) => {
								onSelect(null);
								seek(event.clientX);
							}}
							onDragOver={(event) => {
								if (!accepts(event) || locked) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "copy";
								const index = insertIndexAt(items, secAt(event.clientX));
								if (index !== dropIndex) setDropIndex(index);
							}}
							onDragLeave={() => setDropIndex(null)}
							onDrop={(event) => {
								const payload = parseMaterial(event.dataTransfer.getData(MEDIA_MATERIAL_MIME));
								const index = dropIndex ?? insertIndexAt(items, secAt(event.clientX));
								setDropIndex(null);
								if (!payload || locked) return;
								event.preventDefault();
								onDropMaterial(payload, index);
							}}
						>
							{items.map((item, index) => {
								const trimming = live?.id === item.id && live.mode === "start";
								const moving = live?.id === item.id && live.mode === "move";
								let left = shownStarts[index];
								let width = durations[index];
								if (trimming && live) {
									const range = trimmedHead(item, live.deltaSec);
									const shrink = itemDurationSec(item) - (range.endSec - range.startSec);
									left += shrink;
									width -= shrink;
								}
								return (
									<ItemBlock
										key={item.id}
										item={item}
										index={index}
										asset={assets.find((entry) => entry.id === item.assetId)}
										image={images.find((entry) => entry.id === item.imageId)}
										selected={item.id === selectedId}
										moving={moving}
										style={{
											left: pct(left),
											width: pct(Math.max(0.01, width)),
											...(moving && live && pxPerSec > 0
												? { transform: `translateX(${live.deltaSec * pxPerSec}px)` }
												: {}),
										}}
										durationSec={width}
										onPointerDown={(event, mode) => startDrag(event, item, mode)}
										onPointerMove={moveDrag}
										onPointerUp={endDrag}
									/>
								);
							})}
							{moveIndex !== null || dropIndex !== null ? (
								<span
									className={styles.insert}
									style={{
										left: pct(
											insertionSec(items, starts, moveIndex ?? dropIndex ?? 0, liveItem?.id),
										),
									}}
								/>
							) : null}
							{items.length === 0 ? (
								<span className={styles.laneHint}>
									왼쪽 목록에서 클립·사진·영상을 끌어다 놓거나 ‘타임라인에 추가’를 누르세요.
								</span>
							) : null}
						</div>
						<Playhead viewSec={viewSec} />
					</div>
				</div>
			</div>
		</section>
	);
}

/** Running totals: where each of these lengths starts when laid end to end from 0. */
function cumulative(durations: number[]): number[] {
	let cursor = 0;
	return durations.map((durationSec) => {
		const start = cursor;
		cursor += durationSec;
		return start;
	});
}

/** Where an insertion at `index` (in the list without `exceptId`) lands on the ruler. */
function insertionSec(
	items: AxcutMediaBoardItem[],
	starts: number[],
	index: number,
	exceptId?: string,
): number {
	let seen = 0;
	for (let position = 0; position < items.length; position++) {
		if (items[position].id === exceptId) continue;
		if (seen === index) return starts[position];
		seen++;
	}
	const last = items.length - 1;
	return last >= 0 ? starts[last] + itemDurationSec(items[last]) : 0;
}

function ItemBlock({
	item,
	index,
	asset,
	image,
	selected,
	moving,
	style,
	durationSec,
	onPointerDown,
	onPointerMove,
	onPointerUp,
}: {
	item: AxcutMediaBoardItem;
	index: number;
	asset: AxcutAsset | undefined;
	image: AxcutMediaBoardImage | undefined;
	selected: boolean;
	moving: boolean;
	style: CSSProperties;
	durationSec: number;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
}) {
	const thumbnail = useThumbnail(
		item.kind === "image" ? null : (asset?.originalPath ?? null),
		item.startSec + itemDurationSec(item) / 2,
	);
	const picture = item.kind === "image" && image ? toFileUrl(image.path) : thumbnail;
	const effect = itemEffect(item);
	const effectName =
		effect === "none"
			? ""
			: effect === "random"
				? `랜덤 · ${clipEffectLabel(resolvedItemEffect(item))}`
				: clipEffectLabel(resolvedItemEffect(item));
	const missing = item.kind === "image" ? !image : !asset;
	return (
		<div
			role="button"
			tabIndex={0}
			aria-label={`${index + 1}번 ${item.label || (item.kind === "image" ? "사진" : "클립")}`}
			aria-pressed={selected}
			className={styles.item}
			data-kind={item.kind}
			data-moving={moving}
			data-missing={missing}
			style={style}
			onPointerDown={(event) => onPointerDown(event, "move")}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			{picture ? (
				<img className={styles.thumb} src={picture} alt="" draggable={false} />
			) : (
				<span className={styles.thumbIcon}>
					{item.kind === "image" ? <ImageIcon size={16} /> : <Film size={16} />}
				</span>
			)}
			<span className={styles.itemText}>
				<strong>
					{index + 1}. {item.label || (item.kind === "image" ? "사진" : "클립")}
				</strong>
				<span>
					{formatSeconds(durationSec)}
					{effectName ? ` · ${effectName}` : ""}
				</span>
			</span>
			<span
				className={styles.handle}
				data-edge="start"
				aria-label="앞부분 자르기"
				onPointerDown={(event) => onPointerDown(event, "start")}
			/>
			<span
				className={styles.handle}
				data-edge="end"
				aria-label="길이 조절"
				onPointerDown={(event) => onPointerDown(event, "end")}
			/>
		</div>
	);
}

/** Subscribes to Media's clock on its own, so playback moves one line instead of every item. */
function Playhead({ viewSec }: { viewSec: number }) {
	const time = useMediaPreview((state) => state.timeSec);
	return (
		<div
			className={styles.playhead}
			style={{ left: `${(Math.min(time, viewSec) / viewSec) * 100}%` }}
			aria-hidden
		/>
	);
}
