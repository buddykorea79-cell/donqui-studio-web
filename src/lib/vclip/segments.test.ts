import { describe, expect, it } from "vitest";
import type { VClipWindowAnalysis } from "./contract";
import {
	candidateWindows,
	clampSegmentRange,
	clampSegmentSec,
	mergeAnalysis,
	nextManualRange,
	overlapRatio,
	provisionalSegments,
	rankSegments,
	selectedDurationSec,
	selectionToFill,
	type VClipSegment,
} from "./segments";

function analysis(
	startSec: number,
	endSec: number,
	score: number,
	qualityScore = 70,
): VClipWindowAnalysis {
	return {
		startSec,
		endSec,
		score,
		qualityScore,
		reason: "",
		quality: { brightness: 0.5, motion: 0.5, sharpness: 0.5, stability: 0.5 },
		ai: null,
		aiError: null,
		thumbnail: null,
	};
}

describe("candidateWindows", () => {
	it("covers a short source with one window no longer than the source", () => {
		expect(candidateWindows(3.456, 5)).toEqual([{ startSec: 0, endSec: 3.45 }]);
	});

	it("spreads windows over the whole source, first at 0 and last ending at the end", () => {
		const windows = candidateWindows(20, 5);
		expect(windows).toHaveLength(4);
		expect(windows[0]).toEqual({ startSec: 0, endSec: 5 });
		expect(windows.at(-1)).toEqual({ startSec: 15, endSec: 20 });
		for (const window of windows) expect(window.endSec - window.startSec).toBeCloseTo(5, 5);
	});

	it("thins a long source to the cap but keeps both ends of the footage", () => {
		const windows = candidateWindows(312.3, 5, 12);
		expect(windows).toHaveLength(12);
		expect(windows[0].startSec).toBe(0);
		expect(windows.at(-1)?.endSec).toBe(312.3);
		for (let index = 1; index < windows.length; index++)
			expect(windows[index].startSec).toBeGreaterThan(windows[index - 1].startSec);
	});

	it("never ends a window past the source, even on a fractional duration", () => {
		for (const window of candidateWindows(61.237, 7))
			expect(window.endSec).toBeLessThanOrEqual(61.237);
	});

	it("returns nothing for an unusable duration or cap", () => {
		expect(candidateWindows(0, 5)).toEqual([]);
		expect(candidateWindows(Number.NaN, 5)).toEqual([]);
		expect(candidateWindows(30, 5, 0)).toEqual([]);
	});

	it("clamps the window length to AutoVeo's 2–20 s bounds", () => {
		expect(clampSegmentSec(0.5)).toBe(2);
		expect(clampSegmentSec(90)).toBe(20);
		expect(clampSegmentSec(Number.NaN)).toBe(5);
		expect(candidateWindows(100, 90)[0]).toEqual({ startSec: 0, endSec: 20 });
	});
});

describe("ranking", () => {
	it("measures overlap against the shorter window", () => {
		expect(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 8, endSec: 12 })).toBeCloseTo(0.5);
		expect(overlapRatio({ startSec: 0, endSec: 5 }, { startSec: 5, endSec: 10 })).toBe(0);
	});

	it("drops a window overlapping a better one by more than 40%, then preselects the best three", () => {
		const ranked = rankSegments([
			analysis(0, 5, 70),
			analysis(2, 7, 90), // overlaps the 70 by 60 %: the 70 is dropped
			analysis(10, 15, 60),
			analysis(20, 25, 80),
			analysis(30, 35, 50),
		]);
		expect(ranked.map((segment) => segment.startSec)).toEqual([2, 10, 20, 30]);
		expect(
			ranked.filter((segment) => segment.selected).map((segment) => segment.analysis?.score),
		).toEqual([90, 60, 80]);
		expect(ranked.every((segment) => segment.origin === "auto" && segment.clipId === null)).toBe(
			true,
		);
	});

	it("prefers the sharper, steadier window when the model scored them alike", () => {
		const ranked = rankSegments(
			[analysis(0, 5, 85, 60), analysis(10, 15, 85, 90), analysis(20, 25, 85, 75)],
			{ preselect: 1 },
		);
		expect(ranked.find((segment) => segment.selected)?.startSec).toBe(10);
		expect([...selectionToFill(ranked, 8)]).toEqual(["10.00-15.00", "20.00-25.00"]);
	});

	it("keeps provisional results in source order with nothing selected", () => {
		const provisional = provisionalSegments([analysis(10, 15, 90), analysis(0, 5, 40)]);
		expect(provisional.map((segment) => segment.startSec)).toEqual([0, 10]);
		expect(provisional.every((segment) => !segment.selected)).toBe(true);
		expect(provisional[0].id).toBe("0.00-5.00");
	});
});

describe("filling the audio bed", () => {
	const segments = rankSegments(
		[analysis(0, 5, 60), analysis(10, 15, 90), analysis(20, 24, 80), analysis(30, 35, 70)],
		{ preselect: 0 },
	);

	it("picks the best segments until they cover the time still missing", () => {
		const picked = selectionToFill(segments, 8);
		expect([...picked]).toEqual(["10.00-15.00", "20.00-24.00"]);
	});

	it("takes every segment when even all of them fall short", () => {
		expect(selectionToFill(segments, 600).size).toBe(4);
	});

	it("sums only the selected segments", () => {
		expect(selectedDurationSec(segments)).toBe(0);
		expect(
			selectedDurationSec(
				segments.map((segment) => ({ ...segment, selected: segment.startSec >= 20 })),
			),
		).toBe(9);
	});
});

function segment(
	startSec: number,
	endSec: number,
	extra: Partial<VClipSegment> = {},
): VClipSegment {
	return {
		id: `seg-${startSec}`,
		startSec,
		endSec,
		selected: false,
		origin: "manual",
		analysis: null,
		clipId: null,
		...extra,
	};
}

describe("merging an analysis into the user's segments", () => {
	it("keeps what the user made, drops near-duplicates of it, and preselects nothing new", () => {
		const kept = [
			segment(0, 5, { origin: "bin", clipId: "clip-a" }),
			segment(30, 33, { selected: true }),
		];
		const merged = mergeAnalysis(kept, [
			analysis(0, 5, 95), // the split clip's exact range: lends it its analysis
			analysis(2, 7, 90), // 60 % over the split clip: a near-duplicate
			analysis(10, 15, 80),
			analysis(20, 25, 70),
		]);
		expect(merged.map((item) => [item.startSec, item.origin, item.selected])).toEqual([
			[0, "bin", false],
			[10, "auto", false],
			[20, "auto", false],
			[30, "manual", true],
		]);
		expect(merged[0].analysis?.score).toBe(95);
		expect(merged[0].clipId).toBe("clip-a");
	});

	it("preselects the best three when the source had nothing yet", () => {
		const merged = mergeAnalysis(
			[],
			[analysis(0, 5, 60), analysis(10, 15, 90), analysis(20, 25, 80), analysis(30, 35, 70)],
		);
		expect(merged.filter((item) => item.selected).map((item) => item.startSec)).toEqual([
			10, 20, 30,
		]);
	});
});

describe("adjusting a segment", () => {
	it("keeps it inside the source and at least half a second long", () => {
		expect(clampSegmentRange({ startSec: -2, endSec: 4 }, 20)).toEqual({ startSec: 0, endSec: 4 });
		expect(clampSegmentRange({ startSec: 18, endSec: 25 }, 20)).toEqual({
			startSec: 18,
			endSec: 20,
		});
		// Dragging the start past the end pushes the end along; dragging the end back past
		// the start pulls the start.
		expect(clampSegmentRange({ startSec: 9, endSec: 8 }, 20, "start")).toEqual({
			startSec: 9,
			endSec: 9.5,
		});
		expect(clampSegmentRange({ startSec: 9, endSec: 8 }, 20, "end")).toEqual({
			startSec: 7.5,
			endSec: 8,
		});
		expect(clampSegmentRange({ startSec: 19.9, endSec: 30 }, 20, "start")).toEqual({
			startSec: 19.5,
			endSec: 20,
		});
	});

	it("rounds to the centisecond and tolerates an unknown source length", () => {
		expect(clampSegmentRange({ startSec: 1.23456, endSec: 7.891 }, undefined)).toEqual({
			startSec: 1.23,
			endSec: 7.89,
		});
	});
});

describe("adding a segment by hand", () => {
	it("starts after the last segment there is", () => {
		expect(
			nextManualRange(
				[
					{ startSec: 0, endSec: 5 },
					{ startSec: 8, endSec: 12 },
				],
				60,
				5,
			),
		).toEqual({ startSec: 12, endSec: 17 });
		expect(nextManualRange([], 60, 5)).toEqual({ startSec: 0, endSec: 5 });
	});

	it("pulls back from the end, and never outgrows a short source", () => {
		expect(nextManualRange([{ startSec: 50, endSec: 58 }], 60, 5)).toEqual({
			startSec: 55,
			endSec: 60,
		});
		expect(nextManualRange([], 3.456, 5)).toEqual({ startSec: 0, endSec: 3.45 });
	});
});

describe("filling across sources", () => {
	it("prefers scored segments and takes the ones added by hand last", () => {
		const scored = rankSegments([analysis(0, 5, 70), analysis(10, 15, 90)], { preselect: 0 });
		const manual = segment(40, 46);
		expect([...selectionToFill([manual, ...scored], 9)]).toEqual(["10.00-15.00", "0.00-5.00"]);
		expect([...selectionToFill([manual, ...scored], 11)]).toEqual([
			"10.00-15.00",
			"0.00-5.00",
			"seg-40",
		]);
	});
});
