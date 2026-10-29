import { useEffect, useRef, useState } from "react";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import styles from "./VClipStage.module.css";

/**
 * Plays one range of a source and loops inside it — AutoVeo's segment preview. The range can
 * change while it plays: a new start seeks there, a new end moves the loop point. The two
 * buttons set the range's edges from wherever playback is.
 */
export function SegmentPreview({
	sourceUrl,
	startSec,
	endSec,
	onSetStart,
	onSetEnd,
}: {
	sourceUrl: string;
	startSec: number;
	endSec: number;
	onSetStart: (sec: number) => void;
	onSetEnd: (sec: number) => void;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const range = useRef({ startSec, endSec });
	range.current = { startSec, endSec };
	const [time, setTime] = useState(startSec);
	const [error, setError] = useState(false);

	useEffect(() => {
		const video = videoRef.current;
		if (video && video.readyState >= 1) video.currentTime = startSec;
	}, [startSec]);

	// timeupdate fires four times a second; a frame loop keeps the loop point tight.
	useEffect(() => {
		let frame = 0;
		const tick = () => {
			const video = videoRef.current;
			if (video) {
				const { startSec: start, endSec: end } = range.current;
				if (video.currentTime >= end || video.currentTime < start - 0.25) {
					video.currentTime = start;
				}
				const now = video.currentTime;
				setTime((shown) => (Math.abs(shown - now) >= 0.05 ? now : shown));
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, []);

	if (error)
		return (
			<p role="alert" className={styles.previewError}>
				이 영상은 앱 안에서 재생할 수 없는 형식입니다. 구간 분할과 Media의 효과 렌더링은 FFmpeg로
				그대로 진행됩니다.
			</p>
		);

	const current = Math.min(Math.max(time, startSec), endSec);
	return (
		<div className={styles.player}>
			<video
				ref={videoRef}
				src={sourceUrl}
				controls
				autoPlay
				playsInline
				preload="auto"
				aria-label="구간 미리보기"
				onLoadedMetadata={(event) => {
					event.currentTarget.currentTime = range.current.startSec;
				}}
				onError={() => setError(true)}
			/>
			<div className={styles.playerBar}>
				<span>
					{formatSec(current)}{" "}
					<small>
						/ {formatSec(startSec)}–{formatSec(endSec)}
					</small>
				</span>
				<button type="button" onClick={() => onSetStart(current)}>
					여기를 시작으로
				</button>
				<button type="button" onClick={() => onSetEnd(current)}>
					여기를 끝으로
				</button>
			</div>
		</div>
	);
}
