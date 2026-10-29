import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { ClipEffectProps } from "./catalog";
import { clipEffectStyle } from "./motion";

export function ClipEffectComposition({
	sourceUrl,
	startMs,
	effect,
	sourceKind = "video",
	fit = "contain",
	durationInFrames: ownDuration,
}: ClipEffectProps) {
	const frame = useCurrentFrame();
	const config = useVideoConfig();
	const { fps } = config;
	// Inside a longer composition the effect runs over its own part of it, not the whole.
	const durationInFrames = ownDuration ?? config.durationInFrames;
	const fill = { width: "100%", height: "100%", objectFit: fit } as const;
	return (
		<AbsoluteFill style={{ overflow: "hidden", backgroundColor: "black" }}>
			<AbsoluteFill style={clipEffectStyle(effect, frame, durationInFrames, fps)}>
				{sourceKind === "image" ? (
					<Img src={sourceUrl} style={fill} />
				) : (
					<OffthreadVideo
						src={sourceUrl}
						trimBefore={Math.round((startMs / 1000) * fps)}
						style={fill}
					/>
				)}
			</AbsoluteFill>
		</AbsoluteFill>
	);
}
