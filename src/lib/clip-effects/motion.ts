import type { CSSProperties } from "react";
import type { ClipEffectId } from "./catalog";

export type ClipEffectTransform = {
	scale: number;
	/** Percentages of the output frame, matching CSS translate on AbsoluteFill. */
	translateX: number;
	translateY: number;
	rotation: number;
	opacity: number;
};

/** Frame-only motion shared by the Remotion composition and browser canvas renderer. */
export function clipEffectTransform(
	effect: ClipEffectId,
	frame: number,
	durationInFrames: number,
	fps: number,
): ClipEffectTransform {
	const lastFrame = Math.max(0, durationInFrames - 1);
	const boundedFrame = Math.max(0, Math.min(lastFrame, frame));
	const progress = boundedFrame / Math.max(1, lastFrame);
	const eased = progress * progress * (3 - 2 * progress);
	const entryFrames = Math.max(1, Math.min(fps * 0.6, lastFrame / 3));
	const entry = Math.min(1, boundedFrame / entryFrames);
	const entrance = 1 - (1 - entry) ** 3;
	const identity = { scale: 1, translateX: 0, translateY: 0, rotation: 0, opacity: 1 };
	switch (effect) {
		case "zoom-in":
			return { ...identity, scale: 1 + 0.16 * eased };
		case "zoom-out":
			return { ...identity, scale: 1.16 - 0.16 * eased };
		case "pan-left":
			return { ...identity, scale: 1.18, translateX: 4 - 8 * eased };
		case "pan-right":
			return { ...identity, scale: 1.18, translateX: -4 + 8 * eased };
		case "pan-up":
			return { ...identity, scale: 1.18, translateY: 4 - 8 * eased };
		case "pan-down":
			return { ...identity, scale: 1.18, translateY: -4 + 8 * eased };
		case "fade":
			return { ...identity, opacity: Math.min(entry, (lastFrame - boundedFrame) / entryFrames) };
		case "slide-left":
			return { ...identity, translateX: 16 * (1 - entrance), opacity: entrance };
		case "slide-up":
			return { ...identity, translateY: 16 * (1 - entrance), opacity: entrance };
		case "tilt":
			return { ...identity, scale: 1.12 + 0.06 * eased, rotation: -2 + 4 * eased };
		case "none":
			return identity;
	}
}

/** Preserve the original CSS properties and transform order in desktop Remotion playback. */
export function clipEffectStyle(
	effect: ClipEffectId,
	frame: number,
	durationInFrames: number,
	fps: number,
): CSSProperties {
	const motion = clipEffectTransform(effect, frame, durationInFrames, fps);
	switch (effect) {
		case "zoom-in":
		case "zoom-out":
			return { scale: motion.scale };
		case "pan-left":
		case "pan-right":
			return { scale: motion.scale, translate: `${motion.translateX}% 0` };
		case "pan-up":
		case "pan-down":
			return { scale: motion.scale, translate: `0 ${motion.translateY}%` };
		case "fade":
			return { opacity: motion.opacity };
		case "slide-left":
			return { translate: `${motion.translateX}% 0`, opacity: motion.opacity };
		case "slide-up":
			return { translate: `0 ${motion.translateY}%`, opacity: motion.opacity };
		case "tilt":
			return { scale: motion.scale, rotate: `${motion.rotation}deg` };
		case "none":
			return {};
	}
}
