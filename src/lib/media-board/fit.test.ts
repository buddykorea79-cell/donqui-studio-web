import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutMediaBoardItem,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import {
	FIT_FPS,
	fitComposition,
	fitDurations,
	freeWindow,
	itemFitSlot,
	itemWithDuration,
	narrationPauses,
	narrationSpeech,
	snapCutsToPauses,
} from "./fit";

function item(
	kind: AxcutMediaBoardItem["kind"],
	startSec: number,
	endSec: number,
	id = `${kind}-${startSec}`,
	assetId = "drone",
): AxcutMediaBoardItem {
	return {
		id,
		kind,
		assetId: kind === "image" ? undefined : assetId,
		imageId: kind === "image" ? "photo" : undefined,
		startSec,
		endSec,
		label: id,
		effect: "none",
		seed: "",
	};
}

const frames = (values: number[]) => values.map((value) => Math.round(value * FIT_FPS));
const total = (values: number[]) => frames(values).reduce((sum, value) => sum + value, 0);

describe("fitting durations", () => {
	it("stretches every slot in proportion until they end with the audio", () => {
		const fit = fitDurations(
			[
				{ durationSec: 5, minSec: 0.5, maxSec: 600 },
				{ durationSec: 10, minSec: 0.5, maxSec: 600 },
			],
			30,
		);
		expect(fit.durations).toEqual([10, 20]);
		expect(fit).toMatchObject({ shortSec: 0, overSec: 0 });
	});

	it("stops a slot at its bound and hands the rest to the others", () => {
		const fit = fitDurations(
			[
				{ durationSec: 5, minSec: 0.5, maxSec: 6 }, // a clip near the end of its source
				{ durationSec: 5, minSec: 0.5, maxSec: 600 },
			],
			20,
		);
		expect(fit.durations).toEqual([6, 14]);
	});

	it("shrinks too, and lands on the target frame exactly despite rounding", () => {
		const slots = [3.3, 4.7, 2.9, 5.1].map((durationSec) => ({
			durationSec,
			minSec: 0.5,
			maxSec: 600,
		}));
		const fit = fitDurations(slots, 11.07);
		expect(total(fit.durations)).toBe(Math.round(11.07 * FIT_FPS));
		for (const duration of fit.durations)
			expect(Math.abs(duration * FIT_FPS - Math.round(duration * FIT_FPS))).toBeLessThan(1e-9);
		// Proportions survive: the longest stays the longest.
		expect(fit.durations[3]).toBeGreaterThan(fit.durations[1]);
	});

	it("reports the audio it cannot cover, and the overrun it cannot remove", () => {
		const short = fitDurations([{ durationSec: 4, minSec: 0.5, maxSec: 8 }], 20);
		expect(short).toEqual({ durations: [8], shortSec: 12, overSec: 0 });
		const over = fitDurations(
			Array.from({ length: 10 }, () => ({ durationSec: 2, minSec: 0.5, maxSec: 600 })),
			3,
		);
		expect(over.durations.every((duration) => duration === 0.5)).toBe(true);
		expect(over.overSec).toBeCloseTo(2);
	});

	it("leaves things alone without a target", () => {
		const slots = [{ durationSec: 4, minSec: 0.5, maxSec: 8 }];
		expect(fitDurations(slots, 0).durations).toEqual([4]);
		expect(fitDurations([], 10).durations).toEqual([]);
	});
});

describe("item bounds", () => {
	it("lets a photo hold as long as asked, and a clip grow into its source", () => {
		expect(itemFitSlot(item("image", 0, 4), undefined)).toEqual({
			durationSec: 4,
			minSec: 0.5,
			maxSec: 600,
		});
		expect(itemFitSlot(item("clip", 10, 15), 166.8)).toEqual({
			durationSec: 5,
			minSec: 0.5,
			maxSec: 166.8,
		});
		// With no known length a clip cannot grow.
		expect(itemFitSlot(item("clip", 10, 15), undefined).maxSec).toBe(5);
	});

	it("moves a clip's end, and its start once the end is at the source's end", () => {
		expect(itemWithDuration(item("clip", 10, 15), 8, 60)).toEqual({ startSec: 10, endSec: 18 });
		expect(itemWithDuration(item("clip", 10, 15), 3, 60)).toEqual({ startSec: 10, endSec: 13 });
		expect(itemWithDuration(item("clip", 55, 60), 9, 60)).toEqual({ startSec: 51, endSec: 60 });
		expect(itemWithDuration(item("clip", 2, 7), 90, 60)).toEqual({ startSec: 0, endSec: 90 });
		expect(itemWithDuration(item("image", 0, 4), 6.5, undefined)).toEqual({
			startSec: 0,
			endSec: 6.5,
		});
	});
});

describe("narration", () => {
	function narrated(): AxcutDocument {
		const document = createEmptyDocument({ projectId: "p", title: "Narration" });
		document.audioTracks = [
			{
				...createAudioTrack({ assetId: "voice", durationSec: 30, kind: "voiceover" }),
				startMs: 2000,
				endMs: 14000,
				offsetMs: 1000,
				timelineLocked: true,
			},
			createAudioTrack({ assetId: "music", durationSec: 20, kind: "music" }),
		];
		const word = (id: string, startSec: number, endSec: number) => ({
			id,
			segmentId: "s1",
			startSec,
			endSec,
			text: id,
		});
		document.transcripts = [
			{
				assetId: "voice",
				language: "ko",
				segments: [],
				// File time: speech from 2 s to 4 s, a pause, 5 s to 7.5 s, a pause, 9 s to 11 s.
				words: [
					word("하나", 2, 3),
					word("둘", 3.05, 4),
					word("셋", 5, 7.5),
					word("넷", 9, 11),
					word("", 11, 11.5),
				],
			},
		];
		return document;
	}

	it("maps the words onto where the track plays", () => {
		const [speech] = narrationSpeech(narrated());
		expect(speech.track).toEqual({ startSec: 2, endSec: 14 });
		// File 2 s plays at 2 + (2 − 1) = 3 s.
		expect(speech.spoken[0]).toEqual({ startSec: 3, endSec: 4 });
		expect(speech.spoken).toHaveLength(4);
	});

	it("finds the pauses between words, and just before and after the speech", () => {
		expect(narrationPauses(narrated()).map((value) => Math.round(value * 100) / 100)).toEqual([
			2.85, 5.5, 9.25, 12.15,
		]);
	});

	it("has nothing to say about music, or a narration not yet transcribed", () => {
		const document = narrated();
		document.transcripts = [];
		expect(narrationPauses(document)).toEqual([]);
	});
});

describe("cutting on the narration", () => {
	const slots = [5, 5, 5].map((durationSec) => ({ durationSec, minSec: 0.5, maxSec: 600 }));

	it("moves each cut to the nearest pause within reach and keeps the total", () => {
		const snapped = snapCutsToPauses([5, 5, 5], slots, [4.4, 9.25, 12], 1);
		// Cuts land on frames 132 and 278 (9.25 s rounds up), so the items are 132, 146, 172.
		expect(frames(snapped)).toEqual([132, 146, 172]);
		expect(total(snapped)).toBe(total([5, 5, 5]));
	});

	it("leaves a cut with no pause in reach where the fit put it", () => {
		expect(snapCutsToPauses([5, 5, 5], slots, [7.5], 1)).toEqual([5, 5, 5]);
	});

	it("never breaks an item's bounds to reach a pause", () => {
		const tight = [
			{ durationSec: 5, minSec: 0.5, maxSec: 5.2 },
			{ durationSec: 5, minSec: 0.5, maxSec: 600 },
		];
		// The pause is in reach of the cut but not of the first item's longest: no snap.
		expect(snapCutsToPauses([5, 5], tight, [5.9], 1)).toEqual([5, 5]);
		expect(snapCutsToPauses([5, 5], tight, [5.1], 1)).toEqual([5.1, 4.9]);
	});
});

describe("fitting a composition", () => {
	it("fits every item to the audio and cuts on the pauses", () => {
		const items = [
			item("clip", 10, 15),
			item("image", 0, 5),
			item("video", 0, 5, "video", "beach"),
		];
		const fit = fitComposition(items, 30, () => 120, { pausesSec: [9.4, 20.6] });
		expect(fit).toMatchObject({ shortSec: 0, overSec: 0, snapped: true });
		const ranges = items.map((entry) => fit.ranges.get(entry.id));
		expect(ranges).toEqual([
			{ startSec: 10, endSec: 19.4 },
			{ startSec: 0, endSec: 11.2 },
			{ startSec: 0, endSec: 9.4 },
		]);
	});

	it("grows clips of one source into footage the others do not show", () => {
		// Two clips of a 10.1 s video with a gap between them, and one of a 5.3 s video.
		const items = [
			item("clip", 0, 1.7, "early"),
			item("clip", 5.6, 10.1, "late"),
			item("clip", 0.3, 5.3, "other", "beach"),
		];
		const durations = (entry: AxcutMediaBoardItem) => (entry.assetId === "beach" ? 5.3 : 10.1);
		expect(freeWindow(items[0], items, 10.1)).toEqual({ lo: 0, hi: 3.65 });
		expect(freeWindow(items[1], items, 10.1)).toEqual({ lo: 3.65, hi: 10.1 });
		const fit = fitComposition(items, 12, durations);
		expect(fit).toMatchObject({ shortSec: 0, reused: false });
		const early = fit.ranges.get("early");
		const late = fit.ranges.get("late");
		expect(early && late && early.endSec <= late.startSec).toBe(true);
		expect((early?.endSec ?? 0) <= 3.65 && (late?.startSec ?? 0) >= 3.65).toBe(true);
	});

	it("reuses footage only when the unused footage falls short, and says so", () => {
		const items = [
			item("clip", 0, 1.7, "early"),
			item("clip", 5.6, 10.1, "late"),
			item("clip", 0.3, 5.3, "other", "beach"),
		];
		const durations = (entry: AxcutMediaBoardItem) => (entry.assetId === "beach" ? 5.3 : 10.1);
		// Unused footage: 3.65 + 6.45 + 5.3 = 15.4 s, short of 20.
		const fit = fitComposition(items, 20, durations);
		expect(fit).toMatchObject({ shortSec: 0, overSec: 0, reused: true });
		const total = [...fit.ranges.values()].reduce(
			(sum, range) => sum + range.endSec - range.startSec,
			0,
		);
		expect(total).toBeCloseTo(20, 2);
	});

	it("keeps V.Clip's slightly overlapping segments from growing over each other", () => {
		// Three 5 s segments of a 21.5 s video, 0.9 s apart at each seam, as V.Clip lays them out.
		const items = [
			item("clip", 0, 5, "a"),
			item("clip", 4.1, 9.1, "b"),
			item("clip", 8.2, 13.2, "c"),
		];
		expect(items.map((entry) => freeWindow(entry, items, 21.5))).toEqual([
			{ lo: 0, hi: 5 },
			{ lo: 4.1, hi: 9.1 },
			{ lo: 8.2, hi: 21.5 },
		]);
		const fit = fitComposition(items, 20, () => 21.5);
		expect(fit).toMatchObject({ shortSec: 0, reused: false });
		expect(fit.ranges.get("c")).toEqual({ startSec: 8.2, endSec: 18.2 });
		expect(fitComposition(items, 25, () => 21.5)).toMatchObject({ shortSec: 0, reused: true });
	});

	it("leaves clips that were doubled on purpose free to use the same footage", () => {
		const items = [item("clip", 2, 6, "first"), item("clip", 2, 6, "again")];
		expect(freeWindow(items[0], items, 30)).toEqual({ lo: 0, hi: 30 });
		expect(fitComposition(items, 20, () => 30).reused).toBe(false);
	});

	it("reports what it could not fit, without snapping", () => {
		const fit = fitComposition([item("clip", 0, 5)], 30, () => 8, { pausesSec: [4] });
		expect(fit).toMatchObject({ shortSec: 22, overSec: 0, snapped: false });
		expect(fit.ranges.get("clip-0")).toEqual({ startSec: 0, endSec: 8 });
	});
});
