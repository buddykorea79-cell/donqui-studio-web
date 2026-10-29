import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useMemo, useRef } from "react";
import { CLIP_EFFECT_FPS, type ClipFit } from "@/lib/clip-effects/catalog";
import {
	MediaSequenceComposition,
	type MediaSequenceProps,
	type SequencePart,
} from "@/lib/clip-effects/MediaSequenceComposition";
import { useMediaPreview } from "@/lib/media-board/preview";

/**
 * The whole composition played in the project's frame, with its soundtrack — what Media is
 * fitting, as it will look once applied. Its clock is Media's playhead: the timeline seeks it,
 * and while it plays it moves the playhead.
 */
export function MediaPreview({
	parts,
	audio,
	durationSec,
	width,
	height,
	fit,
}: {
	parts: SequencePart[];
	audio: MediaSequenceProps["audio"];
	durationSec: number;
	width: number;
	height: number;
	fit: ClipFit;
}) {
	const player = useRef<PlayerRef>(null);
	const durationInFrames = Math.max(1, Math.round(durationSec * CLIP_EFFECT_FPS));
	const inputProps = useMemo(() => ({ parts, audio, fit }), [parts, audio, fit]);

	useEffect(() => {
		const element = player.current;
		if (!element) return;
		const store = useMediaPreview.getState();
		const onFrame = (event: { detail: { frame: number } }) =>
			useMediaPreview.getState().setTime(event.detail.frame / CLIP_EFFECT_FPS);
		const onPlay = () => useMediaPreview.getState().setPlaying(true);
		const onPause = () => useMediaPreview.getState().setPlaying(false);
		element.addEventListener("frameupdate", onFrame);
		element.addEventListener("play", onPlay);
		element.addEventListener("pause", onPause);
		element.addEventListener("ended", onPause);
		store.attach({
			seek: (sec) => element.seekTo(Math.round(sec * CLIP_EFFECT_FPS)),
			toggle: () => element.toggle(),
			pause: () => element.pause(),
		});
		// Opens where the playhead was left.
		element.seekTo(Math.round(store.timeSec * CLIP_EFFECT_FPS));
		return () => {
			element.removeEventListener("frameupdate", onFrame);
			element.removeEventListener("play", onPlay);
			element.removeEventListener("pause", onPause);
			element.removeEventListener("ended", onPause);
			useMediaPreview.getState().attach(null);
		};
	}, []);

	const portrait = height > width;
	return (
		<div
			style={{
				position: "relative",
				width: portrait ? "auto" : "100%",
				height: portrait ? "min(460px, 52vh)" : "auto",
				maxHeight: "min(460px, 52vh)",
				aspectRatio: `${width} / ${height}`,
				margin: "0 auto",
				background: "black",
				borderRadius: 8,
				overflow: "hidden",
			}}
		>
			<Player
				ref={player}
				component={MediaSequenceComposition}
				inputProps={inputProps}
				durationInFrames={durationInFrames}
				compositionWidth={width}
				compositionHeight={height}
				fps={CLIP_EFFECT_FPS}
				clickToPlay
				acknowledgeRemotionLicense
				style={{ width: "100%", height: "100%" }}
				errorFallback={({ error }) => (
					<div role="alert" className="p-4 text-sm text-red-300">
						미리보기를 재생할 수 없습니다: {error.message}
					</div>
				)}
			/>
		</div>
	);
}
