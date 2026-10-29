import { describe, expect, it } from "vitest";
import type { WebClip } from "./project";
import { newRegionRange, regionEdgeBounds } from "./regionEditing";

const clip: WebClip = {
	id: "clip",
	assetId: "video",
	trimStart: 3,
	duration: 10,
	volume: 1,
	effect: "none",
	caption: "",
	speedRegions: [
		{ id: "fast", start: 0, end: 6, rate: 2 },
		{ id: "slow", start: 8, end: 9, rate: 0.5 },
	],
	zoomRegions: [
		{ id: "first", start: 1, end: 2, scale: 2, focusX: 0.5, focusY: 0.5 },
		{ id: "middle", start: 4, end: 5, scale: 2, focusX: 0.5, focusY: 0.5 },
		{ id: "last", start: 7, end: 9, scale: 2, focusX: 0.5, focusY: 0.5 },
	],
};

describe("new timeline effect ranges", () => {
	it("maps an output playhead through existing speed before choosing a source range", () => {
		expect(newRegionRange(clip, "zoom", 1.5)).toEqual({ start: 3, end: 4 });
		expect(newRegionRange(clip, "zoom", 0)).toEqual({ start: 0, end: 1 });
	});

	it("selects an occupied same-type interval and permits a different effect at that time", () => {
		expect(newRegionRange(clip, "speed", 1.5)).toEqual({ existingId: "fast" });
		expect(newRegionRange(clip, "zoom", 0.5)).toEqual({ existingId: "first" });
		expect(newRegionRange(clip, "zoom", 1)).toEqual({ start: 2, end: 4 });
	});

	it("bounds newly added effects at the source end and supports very short clips", () => {
		const atEnd = newRegionRange(clip, "speed", 99);
		expect(atEnd.start).toBeCloseTo(9.9);
		expect(atEnd.end).toBe(10);
		expect(
			newRegionRange({ ...clip, duration: 0.05, speedRegions: [], zoomRegions: [] }, "zoom", 1),
		).toEqual({ start: 0, end: 0.05 });
	});
});

describe("timeline effect edge bounds", () => {
	it("finds both neighbours regardless of saved order and ignores the other effect lane", () => {
		const reversed = { ...clip, zoomRegions: [...(clip.zoomRegions ?? [])].reverse() };
		expect(regionEdgeBounds(reversed, "zoom", "middle")).toEqual({ min: 2, max: 7 });
		expect(regionEdgeBounds(clip, "speed", "fast")).toEqual({ min: 0, max: 8 });
	});

	it("uses clip edges for outer or missing regions", () => {
		expect(regionEdgeBounds(clip, "zoom", "first")).toEqual({ min: 0, max: 4 });
		expect(regionEdgeBounds(clip, "zoom", "last")).toEqual({ min: 5, max: 10 });
		expect(regionEdgeBounds(clip, "zoom", "missing")).toEqual({ min: 0, max: 10 });
		expect(regionEdgeBounds({ ...clip, speedRegions: undefined }, "speed", "missing")).toEqual({
			min: 0,
			max: 10,
		});
	});
});
