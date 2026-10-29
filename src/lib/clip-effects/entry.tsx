import { Composition, registerRoot } from "remotion";
import { ClipEffectComposition } from "./ClipEffectComposition";
import { CLIP_EFFECT_FPS } from "./catalog";

function ClipEffectsRoot() {
	return (
		<Composition
			id="DonquiClipEffect"
			component={ClipEffectComposition}
			durationInFrames={30}
			fps={CLIP_EFFECT_FPS}
			width={1920}
			height={1080}
			defaultProps={{ sourceUrl: "", startMs: 0, effect: "none" as const }}
		/>
	);
}

registerRoot(ClipEffectsRoot);
