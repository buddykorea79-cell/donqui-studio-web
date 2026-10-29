import type { CSSProperties } from "react";
import type { ClipEffectId } from "./catalog";

/** Frame-only motion shared by the Player and the exported composition. */
export function clipEffectStyle(
	effect: ClipEffectId,
	frame: number,
	durationInFrames: number,
	fps: number,
): CSSProperties {
	const progress = Math.max(0, Math.min(1, frame / Math.max(1, durationInFrames - 1)));
	const eased = progress * progress * (3 - 2 * progress);
	const entryFrames = Math.max(1, Math.min(fps * 0.6, (durationInFrames - 1) / 3));
	const entry = Math.max(0, Math.min(1, frame / entryFrames));
	const entrance = 1 - (1 - entry) ** 3;
	switch (effect) {
		case "zoom-in":
			return { scale: 1 + 0.16 * eased };
		case "zoom-out":
			return { scale: 1.16 - 0.16 * eased };
		case "pan-left":
			return { scale: 1.18, translate: `${4 - 8 * eased}% 0` };
		case "pan-right":
			return { scale: 1.18, translate: `${-4 + 8 * eased}% 0` };
		case "pan-up":
			return { scale: 1.18, translate: `0 ${4 - 8 * eased}%` };
		case "pan-down":
			return { scale: 1.18, translate: `0 ${-4 + 8 * eased}%` };
		case "fade":
			return { opacity: Math.min(entry, (durationInFrames - 1 - frame) / entryFrames) };
		case "slide-left":
			return { translate: `${16 * (1 - entrance)}% 0`, opacity: entrance };
		case "slide-up":
			return { translate: `0 ${16 * (1 - entrance)}%`, opacity: entrance };
		case "tilt":
			return { scale: 1.12 + 0.06 * eased, rotate: `${-2 + 4 * eased}deg` };
		case "none":
			return {};
	}
}
