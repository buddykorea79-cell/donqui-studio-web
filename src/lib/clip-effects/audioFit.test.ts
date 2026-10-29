import { describe, expect, it } from "vitest";
import { createAudioTrack, createEmptyDocument } from "../ai-edition/schema";
import { audioFitSummary } from "./audioFit";

describe("audio-led clip fitting", () => {
	it("allows an empty audio track list", () => {
		expect(audioFitSummary(createEmptyDocument({ projectId: "p", title: "t" }))).toEqual({
			pictureMs: 0,
			audioMs: 0,
			remainingMs: 0,
		});
	});
	it("uses the furthest audible track end, including narration placed later", () => {
		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		doc.audioTracks = [
			createAudioTrack({ assetId: "music", durationSec: 10 }),
			createAudioTrack({ assetId: "voice", durationSec: 4, timelineStartSec: 12 }),
			{ ...createAudioTrack({ assetId: "muted", durationSec: 100 }), muted: true },
		];
		expect(audioFitSummary(doc).audioMs).toBe(16000);
	});
	it("fits against output duration after speed and visual cuts", () => {
		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		doc.timeline.clips = [
			{
				id: "c",
				assetId: "v",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];
		doc.timeline.trimRanges = [
			{ id: "trim", clipId: "c", assetId: "v", startSec: 0, endSec: 2, reason: "", origin: "user" },
		];
		doc.legacyEditor = { speedRegions: [{ startMs: 0, endMs: 10000, speed: 2 }] };
		doc.audioTracks = [createAudioTrack({ assetId: "a", durationSec: 12 })];
		expect(audioFitSummary(doc)).toEqual({ pictureMs: 4000, audioMs: 12000, remainingMs: 8000 });
	});
});
