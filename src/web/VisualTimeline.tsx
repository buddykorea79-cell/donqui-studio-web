import { Film, Gauge, Maximize2, Minus, Plus, ZoomIn } from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { formatTime } from "./media";
import { getProjectDuration, type WebAsset, type WebClip, type WebProject } from "./project";
import type { RegionSelection } from "./regionEditing";
import {
	getTimelineClips,
	normalizeTimelineRange,
	resizeClipEdge,
	type TimelineRange,
} from "./timelineEditing";
import { clipSourceToOutputTime, getClipOutputDuration } from "./timelineEffects";
import "./timeline.css";

const LABEL_WIDTH = 106;
const FRAME = 1 / 30;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function formatRulerTime(time: number, precise: boolean) {
	if (!precise) return formatTime(time);
	const hundredths = Math.round(Math.max(0, time) * 100);
	const minutes = Math.floor(hundredths / 6000)
		.toString()
		.padStart(2, "0");
	const seconds = Math.floor((hundredths % 6000) / 100)
		.toString()
		.padStart(2, "0");
	return `${minutes}:${seconds}.${(hundredths % 100).toString().padStart(2, "0")}`;
}

type Drag =
	| { type: "seek"; pointerId: number }
	| {
			type: "range";
			pointerId: number;
			anchor: number;
			edge: "new" | "start" | "end";
			original: TimelineRange | null;
			next: TimelineRange;
	  }
	| {
			type: "resize";
			pointerId: number;
			clip: WebClip;
			asset: WebAsset;
			edge: "start" | "end";
			anchorX: number;
			secondsPerPixel: number;
			start: number;
			end: number;
			delta: number;
			result: WebClip;
	  };

export function VisualTimeline({
	project,
	assets,
	time,
	selectedClipId,
	selection,
	disabled,
	range,
	playing,
	onSelectClip,
	onSelectRegion,
	onSeek,
	onRangeChange,
	onResizeClip,
	onPlayFrom,
}: {
	project: WebProject;
	assets: WebAsset[];
	time: number;
	selectedClipId: string | null;
	selection: RegionSelection | null;
	disabled: boolean;
	range: TimelineRange | null;
	playing: boolean;
	onSelectClip: (id: string, position: number) => void;
	onSelectRegion: (selection: RegionSelection, position: number) => void;
	onSeek: (time: number) => void;
	onRangeChange: (range: TimelineRange | null) => void;
	onResizeClip: (id: string, edge: "start" | "end", deltaOutput: number) => void;
	onPlayFrom: (time: number) => void;
}) {
	const scroll = useRef<HTMLDivElement>(null);
	const ruler = useRef<HTMLDivElement>(null);
	const captureElement = useRef<HTMLDivElement | null>(null);
	const [viewportWidth, setViewportWidth] = useState(0);
	const [zoom, setZoom] = useState(1);
	const dragRef = useRef<Drag | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const pendingScroll = useRef<{ time: number; align: "start" | "center" } | null>(null);
	const duration = getProjectDuration(project);
	const clips = getTimelineClips(project);
	const visibleLaneWidth = Math.max(1, viewportWidth - LABEL_WIDTH);
	const laneWidth = visibleLaneWidth * zoom;
	const shownRange = drag?.type === "range" ? normalizeTimelineRange(drag.next, duration) : range;
	const active = !disabled && duration > 0;
	const tickCount = Math.min(
		160,
		Math.max(1, Math.floor(duration * 30)),
		Math.max(5, Math.floor(laneWidth / 100)),
	);
	const position = (start: number, end: number) => ({
		left: `${duration > 0 ? (start / duration) * 100 : 0}%`,
		width: `${duration > 0 ? ((end - start) / duration) * 100 : 0}%`,
	});

	useEffect(() => {
		const element = scroll.current;
		if (!element) return;
		const measure = () =>
			setViewportWidth(element.clientWidth || element.getBoundingClientRect().width);
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(element);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);
	useLayoutEffect(() => {
		const element = scroll.current;
		const pending = pendingScroll.current;
		if (!element || !pending || duration <= 0) return;
		const offset = pending.align === "center" ? visibleLaneWidth / 2 : 16;
		element.scrollLeft = Math.max(0, (pending.time / duration) * laneWidth - offset);
		pendingScroll.current = null;
	}, [laneWidth, visibleLaneWidth, duration]);
	useEffect(() => {
		const element = scroll.current;
		if (!element || !playing || dragRef.current || duration <= 0 || zoom === 1) return;
		const x = (time / duration) * laneWidth;
		if (x < element.scrollLeft || x > element.scrollLeft + visibleLaneWidth - 8) {
			element.scrollLeft = Math.max(0, x - visibleLaneWidth / 4);
		}
	}, [time, playing, duration, laneWidth, visibleLaneWidth, zoom]);

	const updateDrag = (next: Drag | null) => {
		dragRef.current = next;
		setDrag(next);
	};
	const releasePointer = (pointerId: number) => {
		const element = captureElement.current;
		captureElement.current = null;
		if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
	};
	const cancelDrag = () => {
		const previous = dragRef.current;
		updateDrag(null);
		if (previous) releasePointer(previous.pointerId);
	};
	useEffect(() => {
		if (!disabled) return;
		const pointerId = dragRef.current?.pointerId;
		if (pointerId !== undefined && captureElement.current?.hasPointerCapture?.(pointerId)) {
			captureElement.current.releasePointerCapture(pointerId);
		}
		captureElement.current = null;
		dragRef.current = null;
		setDrag(null);
	}, [disabled]);
	useEffect(() => {
		const cancelWithEscape = (event: globalThis.KeyboardEvent) => {
			const current = dragRef.current;
			if (event.key !== "Escape" || !current) return;
			event.preventDefault();
			event.stopPropagation();
			dragRef.current = null;
			setDrag(null);
			const element = captureElement.current;
			captureElement.current = null;
			if (element?.hasPointerCapture?.(current.pointerId))
				element.releasePointerCapture(current.pointerId);
		};
		// Pointer capture need not move keyboard focus into the timeline.
		window.addEventListener("keydown", cancelWithEscape, true);
		return () => window.removeEventListener("keydown", cancelWithEscape, true);
	}, []);

	const atPointer = (clientX: number) => {
		const rect = ruler.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return 0;
		return clamp(
			Math.round(((clientX - rect.left) / rect.width) * duration * 30) / 30,
			0,
			duration,
		);
	};
	const capture = (event: PointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
		// Keeping ruler capture on the ruler preserves native click/double-click targeting.
		const element = event.currentTarget === ruler.current ? ruler.current : scroll.current;
		captureElement.current = element;
		element?.setPointerCapture?.(event.pointerId);
	};
	const beginSeek = (event: PointerEvent) => {
		if (!active || event.button !== 0) return;
		capture(event);
		updateDrag({ type: "seek", pointerId: event.pointerId });
		onSeek(atPointer(event.clientX));
	};
	const beginRange = (event: PointerEvent, edge: "new" | "start" | "end" = "new") => {
		if (!active || event.button !== 0) return;
		capture(event);
		const anchor = atPointer(event.clientX);
		updateDrag({
			type: "range",
			pointerId: event.pointerId,
			anchor,
			edge,
			original: range,
			next: edge === "new" || !range ? { start: anchor, end: anchor } : range,
		});
		onSeek(anchor);
	};
	const beginResize = (
		event: PointerEvent,
		clip: WebClip,
		edge: "start" | "end",
		start: number,
		end: number,
	) => {
		const asset = assets.find((item) => item.id === clip.assetId);
		const width = ruler.current?.getBoundingClientRect().width ?? 0;
		if (!active || !asset || width <= 0 || event.button !== 0) return;
		capture(event);
		onSelectClip(clip.id, edge === "start" ? start : end);
		updateDrag({
			type: "resize",
			pointerId: event.pointerId,
			clip,
			asset,
			edge,
			anchorX: event.clientX,
			secondsPerPixel: duration / width,
			start,
			end,
			delta: 0,
			result: clip,
		});
	};
	const movePointer = (event: PointerEvent) => {
		const previous = dragRef.current;
		if (!previous || previous.pointerId !== event.pointerId || !active) return;
		if (previous.type === "seek") {
			onSeek(atPointer(event.clientX));
			return;
		}
		if (previous.type === "range") {
			const point = atPointer(event.clientX);
			const next =
				previous.edge === "start" && previous.original
					? { start: Math.min(point, previous.original.end - FRAME), end: previous.original.end }
					: previous.edge === "end" && previous.original
						? {
								start: previous.original.start,
								end: Math.max(point, previous.original.start + FRAME),
							}
						: { start: Math.min(previous.anchor, point), end: Math.max(previous.anchor, point) };
			updateDrag({ ...previous, next });
			return;
		}
		const delta =
			Math.round((event.clientX - previous.anchorX) * previous.secondsPerPixel * 30) / 30;
		updateDrag({
			...previous,
			delta,
			result: resizeClipEdge(previous.clip, previous.asset, previous.edge, delta),
		});
	};
	const endPointer = (event: PointerEvent) => {
		const previous = dragRef.current;
		if (!previous || previous.pointerId !== event.pointerId) return;
		// Include a final position even when the browser coalesces the last move event.
		movePointer(event);
		const final = dragRef.current;
		updateDrag(null);
		releasePointer(event.pointerId);
		if (!active || !final) return;
		if (final.type === "range") onRangeChange(normalizeTimelineRange(final.next, duration));
		else if (
			final.type === "resize" &&
			(Math.abs(final.result.duration - final.clip.duration) > 1e-7 ||
				Math.abs(final.result.trimStart - final.clip.trimStart) > 1e-7)
		) {
			onResizeClip(final.clip.id, final.edge, final.delta);
		}
	};
	const changeZoom = (next: number, anchor = time, align: "start" | "center" = "center") => {
		const bounded = clamp(Math.round(next * 4) / 4, 1, 32);
		pendingScroll.current = { time: anchor, align };
		if (bounded === zoom && scroll.current) {
			scroll.current.scrollLeft = Math.max(
				0,
				(anchor / duration) * laneWidth - (align === "center" ? visibleLaneWidth / 2 : 16),
			);
			pendingScroll.current = null;
		}
		setZoom(bounded);
	};
	const rulerKey = (event: KeyboardEvent) => {
		if (!active) return;
		const step = event.shiftKey ? 1 : FRAME;
		const target =
			event.key === "Home"
				? 0
				: event.key === "End"
					? duration
					: event.key === "ArrowLeft"
						? time - step
						: event.key === "ArrowRight"
							? time + step
							: null;
		if (target !== null) {
			event.preventDefault();
			event.stopPropagation();
			onSeek(clamp(target, 0, duration));
		} else if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			onPlayFrom(time);
		}
	};
	const resizeKey = (event: KeyboardEvent, clipId: string, edge: "start" | "end") => {
		if (!active || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
		event.preventDefault();
		event.stopPropagation();
		onResizeClip(clipId, edge, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : FRAME));
	};
	const rangeKey = (event: KeyboardEvent, edge: "start" | "end") => {
		if (!active || !range || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
		event.preventDefault();
		event.stopPropagation();
		const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : FRAME);
		onRangeChange(
			edge === "start"
				? { ...range, start: clamp(range.start + delta, 0, range.end - FRAME) }
				: { ...range, end: clamp(range.end + delta, range.start + FRAME, duration) },
		);
	};
	const overlay = () => (
		<>
			{shownRange && (
				<span className="vt-selection-shade" style={position(shownRange.start, shownRange.end)} />
			)}
			<span
				className="vt-playhead"
				style={{ left: `${duration > 0 ? clamp(time / duration, 0, 1) * 100 : 0}%` }}
			/>
		</>
	);

	return (
		<section className="vt" aria-label="영상 효과 타임라인">
			<div className="vt-tools">
				<div className="vt-zoom-tools" role="group" aria-label="타임라인 보기">
					<button
						type="button"
						disabled={!active || zoom <= 1}
						onClick={() => changeZoom(zoom / 2)}
						aria-label="타임라인 축소"
					>
						<Minus size={14} />
					</button>
					<input
						aria-label="타임라인 확대 배율"
						type="range"
						min={1}
						max={32}
						step={0.25}
						value={zoom}
						disabled={!active}
						onChange={(event) => changeZoom(Number(event.target.value))}
					/>
					<button
						type="button"
						disabled={!active || zoom >= 32}
						onClick={() => changeZoom(zoom * 2)}
						aria-label="타임라인 확대"
					>
						<Plus size={14} />
					</button>
					<span>{zoom}×</span>
					<button type="button" disabled={!active} onClick={() => changeZoom(1, 0, "start")}>
						<Maximize2 size={13} />
						전체 보기
					</button>
					<button
						type="button"
						disabled={!active || !range}
						onClick={() => {
							if (range)
								changeZoom((duration / (range.end - range.start)) * 0.9, range.start, "start");
						}}
					>
						선택 구간 확대
					</button>
				</div>
				<span className="vt-help">눈금 클릭: 이동 · 두 번 클릭: 재생 · 클립 양끝: 길이 조절</span>
			</div>
			<div
				ref={scroll}
				className="vt-scroll"
				onPointerMove={movePointer}
				onPointerUp={endPointer}
				onPointerCancel={cancelDrag}
				onLostPointerCapture={() => {
					if (dragRef.current) cancelDrag();
				}}
			>
				<div
					className="vt-grid"
					style={{ width: viewportWidth > 0 ? LABEL_WIDTH + laneWidth : "100%" }}
				>
					<span className="vt-label">완성 영상 시간</span>
					<div
						ref={ruler}
						className="vt-ruler"
						role="slider"
						tabIndex={active ? 0 : -1}
						aria-label="타임라인 재생 위치"
						aria-valuemin={0}
						aria-valuemax={duration}
						aria-valuenow={time}
						aria-valuetext={formatTime(time)}
						aria-disabled={!active}
						onPointerDown={beginSeek}
						onKeyDown={rulerKey}
						onDoubleClick={(event) => {
							if (active) onPlayFrom(atPointer(event.clientX));
						}}
					>
						{Array.from({ length: tickCount + 1 }, (_, index) => (
							<span
								key={index}
								className={`vt-tick ${index === tickCount ? "last" : ""}`}
								style={{ left: `${(index / tickCount) * 100}%` }}
							>
								{formatRulerTime((duration * index) / tickCount, duration / tickCount < 0.2)}
							</span>
						))}
						{overlay()}
					</div>
					<div className="vt-label">구간 선택</div>
					<div
						className="vt-range-lane"
						role="group"
						aria-label="구간 선택 트랙"
						onPointerDown={(event) => beginRange(event)}
					>
						{shownRange ? (
							<div className="vt-range" style={position(shownRange.start, shownRange.end)}>
								<span>
									{formatTime(shownRange.start)} ~ {formatTime(shownRange.end)}
								</span>
								<button
									type="button"
									className="vt-handle start"
									aria-label="선택 구간 시작점"
									disabled={!active}
									onPointerDown={(event) => beginRange(event, "start")}
									onKeyDown={(event) => rangeKey(event, "start")}
								/>
								<button
									type="button"
									className="vt-handle end"
									aria-label="선택 구간 끝점"
									disabled={!active}
									onPointerDown={(event) => beginRange(event, "end")}
									onKeyDown={(event) => rangeKey(event, "end")}
								/>
							</div>
						) : (
							<span className="vt-hint">여기를 드래그해 편집할 구간을 선택하세요</span>
						)}
						<span
							className="vt-playhead"
							style={{ left: `${duration > 0 ? clamp(time / duration, 0, 1) * 100 : 0}%` }}
						/>
					</div>
					<div className="vt-label">
						<Film size={16} />
						영상 · 사진
					</div>
					<div className="vt-lane vt-clips">
						{clips.map(({ clip, start, end }, index) => {
							const asset = assets.find((item) => item.id === clip.assetId);
							return (
								<div
									key={clip.id}
									className={`vt-clip ${selectedClipId === clip.id ? "selected" : ""}`}
									style={position(start, end)}
								>
									<button
										type="button"
										className="vt-clip-body"
										disabled={!active}
										aria-label={`${String(index + 1).padStart(2, "0")} ${asset?.name ?? "미디어"} ${formatTime(end - start)}${clip.caption ? " · 자막" : ""}`}
										title={`${asset?.name ?? "미디어"} · ${formatTime(end - start)}`}
										onClick={(event) =>
											onSelectClip(
												clip.id,
												event.detail === 0 ? start : clamp(atPointer(event.clientX), start, end),
											)
										}
										onDoubleClick={(event) =>
											onPlayFrom(clamp(atPointer(event.clientX), start, end))
										}
									>
										<span className="vt-clip-number">{String(index + 1).padStart(2, "0")}</span>
										<strong>{asset?.name ?? "미디어"}</strong>
										<small>
											{formatTime(end - start)}
											{clip.caption && " · 자막"}
										</small>
									</button>
									<button
										type="button"
										className="vt-handle start"
										aria-label={`클립 ${index + 1} 시작점 조절`}
										disabled={!active}
										onPointerDown={(event) => beginResize(event, clip, "start", start, end)}
										onKeyDown={(event) => resizeKey(event, clip.id, "start")}
									/>
									<button
										type="button"
										className="vt-handle end"
										aria-label={`클립 ${index + 1} 끝점 조절`}
										disabled={!active}
										onPointerDown={(event) => beginResize(event, clip, "end", start, end)}
										onKeyDown={(event) => resizeKey(event, clip.id, "end")}
									/>
								</div>
							);
						})}
						{drag?.type === "resize" && (
							<div
								className="vt-resize-ghost"
								style={position(
									Math.max(
										0,
										drag.edge === "start"
											? drag.end - getClipOutputDuration(drag.result)
											: drag.start,
									),
									drag.edge === "end" ? drag.start + getClipOutputDuration(drag.result) : drag.end,
								)}
							>
								{formatTime(getClipOutputDuration(drag.result))}
							</div>
						)}
						{overlay()}
					</div>
					{(["zoom", "speed"] as const).map((kind) => (
						<div className="vt-row" key={kind}>
							<div className="vt-label">
								{kind === "zoom" ? <ZoomIn size={16} /> : <Gauge size={16} />}
								{kind === "zoom" ? "돋보기" : "속도"}
							</div>
							<div className={`vt-lane vt-regions ${kind}`}>
								{!clips.some(
									({ clip }) => (kind === "zoom" ? clip.zoomRegions : clip.speedRegions)?.length,
								) && (
									<span className="vt-hint">
										구간을 선택한 뒤 + {kind === "zoom" ? "돋보기" : "속도"}를 누르세요
									</span>
								)}
								{clips.flatMap(({ clip, start }) =>
									(kind === "zoom" ? (clip.zoomRegions ?? []) : (clip.speedRegions ?? [])).map(
										(region) => {
											const begin = start + clipSourceToOutputTime(clip, region.start);
											const end = start + clipSourceToOutputTime(clip, region.end);
											const label =
												"scale" in region ? `돋보기 ${region.scale}×` : `속도 ${region.rate}×`;
											return (
												<button
													type="button"
													disabled={!active}
													key={`${clip.id}-${region.id}`}
													className={`vt-region ${selection?.clipId === clip.id && selection.id === region.id && selection.kind === kind ? "selected" : ""}`}
													style={position(begin, end)}
													title={`${label} · ${formatTime(begin)} ~ ${formatTime(end)}`}
													aria-label={`${label} 구간 ${formatTime(begin)}부터`}
													onClick={() =>
														onSelectRegion(
															{ clipId: clip.id, kind, id: region.id },
															(begin + end) / 2,
														)
													}
												>
													{label}
												</button>
											);
										},
									),
								)}
								{overlay()}
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
