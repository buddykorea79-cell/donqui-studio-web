import { describe, expect, it } from "vitest";
import { CLIP_EFFECTS } from "./catalog";
import { clipEffectStyle, clipEffectTransform } from "./motion";

describe("shared clip effect motion", () => {
	it("moves in the named direction without losing the scale that covers the edges", () => {
		for (const [effect, axis, direction] of [
			["pan-left", "translateX", -1],
			["pan-right", "translateX", 1],
			["pan-up", "translateY", -1],
			["pan-down", "translateY", 1],
		] as const) {
			const first = clipEffectTransform(effect, 0, 60, 30);
			const last = clipEffectTransform(effect, 59, 60, 30);
			expect((last[axis] - first[axis]) * direction).toBe(8);
			expect(first.scale).toBe(1.18);
			expect(last.scale).toBe(1.18);
		}
	});

	it("finishes slide entrances on the original frame without a remaining offset", () => {
		const horizontalStart = clipEffectTransform("slide-left", 0, 60, 30);
		const verticalStart = clipEffectTransform("slide-up", 0, 60, 30);
		expect(horizontalStart.translateX).toBe(16);
		expect(verticalStart.translateY).toBe(16);
		expect(horizontalStart.opacity).toBe(0);
		for (const effect of ["slide-left", "slide-up"] as const) {
			const entranceEnd = clipEffectTransform(effect, 18, 60, 30);
			expect(entranceEnd).toEqual({
				scale: 1,
				translateX: 0,
				translateY: 0,
				rotation: 0,
				opacity: 1,
			});
		}
	});

	it("clamps scrubbing past either endpoint and keeps opacity valid even for one-frame clips", () => {
		for (const effect of CLIP_EFFECTS) {
			for (const frames of [1, 6, 60]) {
				expect(clipEffectTransform(effect.id, -30, frames, 30)).toEqual(
					clipEffectTransform(effect.id, 0, frames, 30),
				);
				expect(clipEffectTransform(effect.id, frames + 30, frames, 30)).toEqual(
					clipEffectTransform(effect.id, frames - 1, frames, 30),
				);
				for (const frame of [-1, 0, frames / 2, frames, frames + 1]) {
					const motion = clipEffectTransform(effect.id, frame, frames, 30);
					expect(Object.values(motion).every(Number.isFinite)).toBe(true);
					expect(motion.opacity).toBeGreaterThanOrEqual(0);
					expect(motion.opacity).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	it("keeps the desktop CSS transform properties and the original tilt endpoints", () => {
		expect(clipEffectStyle("none", 20, 60, 30)).toEqual({});
		expect(clipEffectStyle("pan-left", 0, 60, 30)).toEqual({ scale: 1.18, translate: "4% 0" });
		expect(clipEffectStyle("pan-down", 59, 60, 30)).toEqual({
			scale: 1.18,
			translate: "0 4%",
		});
		expect(clipEffectStyle("tilt", 0, 60, 30)).toEqual({ scale: 1.12, rotate: "-2deg" });
		const tiltEnd = clipEffectTransform("tilt", 59, 60, 30);
		expect(tiltEnd.rotation).toBe(2);
		expect(tiltEnd.scale).toBeCloseTo(1.18);
	});
});
