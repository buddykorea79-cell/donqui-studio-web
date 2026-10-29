import { describe, expect, it } from "vitest";
import { CLIP_EFFECTS, clipEffectDimensions, resolveClipEffect } from "./catalog";
import { clipEffectStyle } from "./motion";

describe("clip effect choices", () => {
	it("resolves random once reproducibly and covers all ten effects", () => {
		const effects = new Set(
			Array.from({ length: 500 }, (_, index) => resolveClipEffect("random", `clip-${index}`)),
		);
		expect(effects.size).toBe(10);
		expect(effects.has("none")).toBe(false);
		expect(resolveClipEffect("random", "saved-clip")).toBe(
			resolveClipEffect("random", "saved-clip"),
		);
		expect(resolveClipEffect("pan-left", "different-seed")).toBe("pan-left");
		expect(resolveClipEffect("none", "different-seed")).toBe("none");
	});
	it("preserves portrait and landscape ratios within the 4K ceiling", () => {
		expect(clipEffectDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(clipEffectDimensions(3840, 2160)).toEqual({ width: 3840, height: 2160 });
		expect(clipEffectDimensions(7680, 4320)).toEqual({ width: 3840, height: 2160 });
		expect(clipEffectDimensions(4320, 7680)).toEqual({ width: 2160, height: 3840 });
		expect(clipEffectDimensions(641, 361)).toEqual({ width: 640, height: 360 });
	});
	it("can seek backward without history changing any effect", () => {
		for (const effect of CLIP_EFFECTS) {
			const before = clipEffectStyle(effect.id, 7, 60, 30);
			clipEffectStyle(effect.id, 55, 60, 30);
			expect(clipEffectStyle(effect.id, 7, 60, 30)).toEqual(before);
			expect(JSON.stringify(before)).not.toContain("NaN");
		}
	});
});
