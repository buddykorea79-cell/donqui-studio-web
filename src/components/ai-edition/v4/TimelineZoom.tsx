import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./TimelineZoom.module.css";

/**
 * Stretching and shrinking a scrolling timeline — Audio's and Media's. The canvas is `zoom`
 * times the scroller's width; a zoom keeps the moment under the pointer (or the view's middle)
 * where it was, so the thing being looked at never jumps away.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 40;
const STEP = 1.5;
const WHEEL_STEP = 1.15;

const clampZoom = (value: number) =>
	Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(value) ? value : MIN_ZOOM));

export interface TimelineZoom {
	zoom: number;
	/** Zooms to `value`, keeping the moment at `clientX` (default: the view's middle) in place. */
	zoomTo: (value: number, clientX?: number) => void;
	zoomIn: () => void;
	zoomOut: () => void;
	/** Back to the whole timeline in view. */
	fit: () => void;
}

export function useTimelineZoom(scroller: RefObject<HTMLDivElement | null>): TimelineZoom {
	const [zoom, setZoom] = useState(MIN_ZOOM);
	const current = useRef(zoom);
	current.current = zoom;
	// The canvas fraction to keep under a scroller x once the new width has been laid out.
	const anchor = useRef<{ fraction: number; x: number } | null>(null);

	const zoomTo = useCallback(
		(value: number, clientX?: number) => {
			const next = clampZoom(value);
			if (next === current.current) return;
			const element = scroller.current;
			if (element && element.scrollWidth > 0) {
				const x =
					clientX === undefined
						? element.clientWidth / 2
						: clientX - element.getBoundingClientRect().left;
				anchor.current = { fraction: (element.scrollLeft + x) / element.scrollWidth, x };
			}
			setZoom(next);
		},
		[scroller],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new zoom is laid out
	useLayoutEffect(() => {
		const element = scroller.current;
		const kept = anchor.current;
		anchor.current = null;
		if (!element || !kept) return;
		element.scrollLeft = Math.max(0, kept.fraction * element.scrollWidth - kept.x);
	}, [zoom]);

	// Ctrl (⌘) + wheel zooms around the pointer. Native and non-passive: React's wheel handler
	// is passive, and the browser would take the gesture as a page zoom.
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
			if (delta === 0) return;
			zoomTo(current.current * (delta > 0 ? 1 / WHEEL_STEP : WHEEL_STEP), event.clientX);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [scroller, zoomTo]);

	return {
		zoom,
		zoomTo,
		zoomIn: () => zoomTo(current.current * STEP),
		zoomOut: () => zoomTo(current.current / STEP),
		fit: () => zoomTo(MIN_ZOOM),
	};
}

/** −, a slider, + and "fit", for a timeline's toolbar. The slider moves in powers, like the wheel. */
export function ZoomControls({ zoom }: { zoom: TimelineZoom }) {
	const max = Math.log2(MAX_ZOOM);
	return (
		<div className={styles.zoom} role="group" aria-label="타임라인 확대·축소">
			<button
				type="button"
				aria-label="타임라인 축소"
				title="타임라인 축소 (Ctrl + 휠)"
				disabled={zoom.zoom <= MIN_ZOOM}
				onClick={zoom.zoomOut}
			>
				<ZoomOut size={14} />
			</button>
			<input
				type="range"
				aria-label="타임라인 배율"
				min={0}
				max={max}
				step={0.01}
				value={Math.log2(zoom.zoom)}
				onChange={(event) => zoom.zoomTo(2 ** Number(event.target.value))}
			/>
			<button
				type="button"
				aria-label="타임라인 확대"
				title="타임라인 확대 (Ctrl + 휠)"
				disabled={zoom.zoom >= MAX_ZOOM}
				onClick={zoom.zoomIn}
			>
				<ZoomIn size={14} />
			</button>
			<span className={styles.value}>
				×{zoom.zoom < 10 ? zoom.zoom.toFixed(1) : Math.round(zoom.zoom)}
			</span>
			<button
				type="button"
				aria-label="타임라인 전체 보기"
				title="타임라인 전체 보기"
				disabled={zoom.zoom <= MIN_ZOOM}
				onClick={zoom.fit}
			>
				<Maximize2 size={13} />
			</button>
		</div>
	);
}
