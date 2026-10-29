import { Player } from "@remotion/player";
import { useMemo } from "react";
import { ClipEffectComposition } from "@/lib/clip-effects/ClipEffectComposition";
import {
	CLIP_EFFECT_FPS,
	type ClipEffectId,
	type ClipSourceKind,
} from "@/lib/clip-effects/catalog";

export interface ClipPreviewProps {
	sourceUrl: string;
	/** A photo holds still for the whole clip; `startMs` is then ignored. */
	sourceKind?: ClipSourceKind;
	startMs: number;
	endMs: number;
	effect: ClipEffectId;
	width?: number;
	height?: number;
}

/** The Remotion composition the render uses, played live: what you see is what gets rendered. */
export function ClipPreview({
	sourceUrl,
	sourceKind = "video",
	startMs,
	endMs,
	effect,
	width = 1920,
	height = 1080,
}: ClipPreviewProps) {
	const inputProps = useMemo(
		() => ({ sourceUrl, startMs, effect, sourceKind }),
		[sourceUrl, startMs, effect, sourceKind],
	);
	const durationInFrames = Math.max(1, Math.round(((endMs - startMs) / 1000) * CLIP_EFFECT_FPS));
	return (
		<Player
			key={`${sourceUrl}:${startMs}:${endMs}:${effect}`}
			component={ClipEffectComposition}
			inputProps={inputProps}
			durationInFrames={durationInFrames}
			compositionWidth={width}
			compositionHeight={height}
			fps={CLIP_EFFECT_FPS}
			controls
			loop
			autoPlay
			clickToPlay
			acknowledgeRemotionLicense
			style={{ width: "100%", maxHeight: 360, backgroundColor: "black" }}
			errorFallback={({ error }) => (
				<div role="alert" className="p-4 text-sm text-red-300">
					미리보기를 재생할 수 없습니다: {error.message}
				</div>
			)}
		/>
	);
}
