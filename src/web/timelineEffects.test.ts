import { describe, expect, it } from "vitest";
import type { WebClip } from "./project";
import {
	clipOutputToSourceTime,
	clipPlaybackRateAt,
	clipSourceToOutputTime,
	getClipOutputDuration,
	getClipTiming,
	getZoomTransform,
	normalizeClipRegions,
	splitClipAtOutputTime,
} from "./timelineEffects";

const clip: WebClip = {
	id: "clip",
	assetId: "video",
	trimStart: 4,
	duration: 10,
	volume: 1,
	effect: "none",
	caption: "",
	speedRegions: [
		{ id: "fast", start: 2, end: 6, rate: 2 },
		{ id: "slow", start: 8, end: 10, rate: 0.5 },
	],
	zoomRegions: [{ id: "zoom", start: 2, end: 8, scale: 3, focusX: 0.8, focusY: 0.3 }],
};

describe("clip source and output timing", () => {
	it("accounts for normal, fast and slow ranges without altering source duration", () => {
		expect(getClipTiming(clip)).toEqual([
			{ sourceStart: 0, sourceEnd: 2, outputStart: 0, outputEnd: 2, rate: 1 },
			{ sourceStart: 2, sourceEnd: 6, outputStart: 2, outputEnd: 4, rate: 2 },
			{ sourceStart: 6, sourceEnd: 8, outputStart: 4, outputEnd: 6, rate: 1 },
			{ sourceStart: 8, sourceEnd: 10, outputStart: 6, outputEnd: 10, rate: 0.5 },
		]);
		expect(getClipOutputDuration(clip)).toBe(10);
		expect(clip.duration).toBe(10);
	});

	it("maps boundaries to the next region and clamps seeking outside the clip", () => {
		expect(clipOutputToSourceTime(clip, 3)).toBe(4);
		expect(clipSourceToOutputTime(clip, 9)).toBe(8);
		expect(clipPlaybackRateAt(clip, 2)).toBe(2);
		expect(clipPlaybackRateAt(clip, 4)).toBe(1);
		expect(clipPlaybackRateAt(clip, 6)).toBe(0.5);
		expect(clipOutputToSourceTime(clip, -1)).toBe(0);
		expect(clipOutputToSourceTime(clip, 99)).toBe(10);
		expect(clipSourceToOutputTime(clip, -1)).toBe(0);
		expect(clipSourceToOutputTime(clip, 99)).toBe(10);
		for (let source = 0; source <= clip.duration; source += 0.05) {
			expect(clipOutputToSourceTime(clip, clipSourceToOutputTime(clip, source))).toBeCloseTo(
				source,
				8,
			);
		}
	});

	it("orders speed regions without mutating saved order and supports old clips", () => {
		const unsorted = { ...clip, speedRegions: [...(clip.speedRegions ?? [])].reverse() };
		expect(getClipTiming(unsorted)).toEqual(getClipTiming(clip));
		expect(unsorted.speedRegions[0].id).toBe("slow");
		const old = { ...clip, speedRegions: undefined, zoomRegions: undefined };
		expect(getClipOutputDuration(old)).toBe(10);
		expect(clipOutputToSourceTime(old, 4)).toBe(4);
		expect(clipPlaybackRateAt(old, 4)).toBe(1);
		expect(normalizeClipRegions(old).speedRegions).toBeUndefined();
	});

	it("clips or removes ranges after shortening the source span", () => {
		const shortened = normalizeClipRegions({ ...clip, duration: 5 });
		expect(shortened.speedRegions).toEqual([{ id: "fast", start: 2, end: 5, rate: 2 }]);
		expect(shortened.zoomRegions?.[0]).toMatchObject({ start: 2, end: 5 });
		expect(getClipOutputDuration(shortened)).toBe(3.5);
		expect(clip.speedRegions?.[0].end).toBe(6);
	});

	it("splits at the speed-adjusted source frame and preserves both halves' duration", () => {
		const [left, right] = splitClipAtOutputTime(clip, 3, "second");
		expect(left.duration).toBe(4);
		expect(right.trimStart).toBe(8);
		expect(right.duration).toBe(6);
		expect(getClipOutputDuration(left)).toBe(3);
		expect(getClipOutputDuration(right)).toBe(7);
		expect(right.speedRegions?.map(({ start, end, rate }) => ({ start, end, rate }))).toEqual([
			{ start: 0, end: 2, rate: 2 },
			{ start: 4, end: 6, rate: 0.5 },
		]);
		expect(right.zoomRegions?.[0]).toMatchObject({ start: 0, end: 4, easeInOffset: 1 });
		expect(left.zoomRegions?.[0]).toMatchObject({ start: 2, end: 4, easeOutOffset: 3 });
		expect(right.zoomRegions?.[0].id).not.toBe(clip.zoomRegions?.[0].id);
		expect(right.speedRegions?.[0].id).not.toBe(clip.speedRegions?.[0].id);
		expect(getZoomTransform(left, 3 - 1e-6).scale).toBe(3);
		expect(getZoomTransform(right, 0).scale).toBe(3);
		expect(splitClipAtOutputTime(clip, 3, "photo", true)[1].trimStart).toBe(0);
		expect(() => splitClipAtOutputTime(clip, 0, "invalid")).toThrow("안쪽");
		expect(() => splitClipAtOutputTime(clip, 10, "invalid")).toThrow("안쪽");
	});

	it("does not keep an ended region or disable a new region's entry when splitting at a boundary", () => {
		const [left, right] = splitClipAtOutputTime(clip, 2, "second");
		expect(left.zoomRegions).toEqual([]);
		expect(right.zoomRegions?.[0].easeInOffset).toBeUndefined();
		expect(getZoomTransform(right, 0).scale).toBe(1);
	});
});

describe("focus zoom timing", () => {
	it("preserves every zoom frame when splitting during entry or exit, including repeated splits", () => {
		for (const splitTime of [2.025, 2.125, 2.24, 5.76, 5.875, 5.975]) {
			const [left, right] = splitClipAtOutputTime(clip, splitTime, "second");
			for (let outputTime = 0; outputTime < 10; outputTime += 0.01) {
				const fragment = outputTime < splitTime ? left : right;
				const localTime = outputTime < splitTime ? outputTime : outputTime - splitTime;
				expect(getZoomTransform(fragment, localTime).scale).toBeCloseTo(
					getZoomTransform(clip, outputTime).scale,
					7,
				);
			}
			const laterSplit = 0.015;
			const [middle, last] = splitClipAtOutputTime(right, laterSplit, "third");
			for (let localTime = 0; localTime < getClipOutputDuration(right); localTime += 0.01) {
				const fragment = localTime < laterSplit ? middle : last;
				const fragmentTime = localTime < laterSplit ? localTime : localTime - laterSplit;
				expect(getZoomTransform(fragment, fragmentTime).scale).toBeCloseTo(
					getZoomTransform(clip, splitTime + localTime).scale,
					7,
				);
			}
		}
	});

	it("uses the requested focus and eases independently of source playback rate", () => {
		expect(getZoomTransform(clip, 1)).toEqual({ scale: 1, focusX: 0.5, focusY: 0.5 });
		expect(getZoomTransform(clip, 2)).toMatchObject({ scale: 1, focusX: 0.8, focusY: 0.3 });
		expect(getZoomTransform(clip, 2.125).scale).toBe(2);
		expect(getZoomTransform(clip, 2.25).scale).toBe(3);
		expect(getZoomTransform(clip, 5.875).scale).toBe(2);
		expect(getZoomTransform(clip, 6)).toEqual({ scale: 1, focusX: 0.5, focusY: 0.5 });
	});

	it("bounds the ramp for a short zoom so it still reaches the selected magnification", () => {
		const short = {
			...clip,
			zoomRegions: [{ id: "short", start: 2, end: 2.2, scale: 2, focusX: 0, focusY: 1 }],
		};
		expect(getZoomTransform(short, 2.05).scale).toBeCloseTo(2);
		expect(getZoomTransform(short, 2.025).scale).toBeCloseTo(1.5);
	});
});
