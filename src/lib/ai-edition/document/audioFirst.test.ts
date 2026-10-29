import { describe, expect, it } from "vitest";
import { type AxcutClip, createAudioTrack, createEmptyDocument, documentSchema } from "../schema";
import { audioProgrammeDuration, editAudioFirstTrack } from "./audioFirst";
import { placeAudioTrackInDocument } from "./audioTracks";
import {
	applyProbedDuration,
	projectPlaybackSecToRawTimeline,
	projectRawTimelineSecToPlayback,
	withClipsChanged,
} from "./timeline";

function audioProject() {
	const document = createEmptyDocument({ projectId: "audio-first", title: "Song first" });
	document.assets = [
		{
			id: "music",
			kind: "audio",
			label: "Song",
			originalPath: "/song.wav",
			durationSec: 90,
			cameraTrack: null,
		},
	];
	const track = {
		...createAudioTrack({ assetId: "music", durationSec: 90 }),
		timelineLocked: true,
	};
	return placeAudioTrackInDocument(document, track, () => "fragment", "create");
}
function visual(id: string, start: number, duration: number): AxcutClip {
	return {
		id,
		assetId: id,
		sourceStartSec: 0,
		sourceEndSec: duration,
		timelineStartSec: start,
		timelineEndSec: start + duration,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

describe("audio-first soundtrack", () => {
	it("round-trips tab playheads and soundtrack geometry through speeds and cuts", () => {
		const clips = [visual("video", 0, 20)];
		const speed = [{ startMs: 0, endMs: 20_000, speed: 2 }];
		expect(projectRawTimelineSecToPlayback(clips, [], 8, speed)).toBe(4);
		expect(projectPlaybackSecToRawTimeline(clips, [], 4, speed)).toBeCloseTo(8, 8);
		const trims = [
			{
				id: "cut",
				assetId: "video",
				clipId: "video",
				startSec: 4,
				endSec: 6,
				origin: "user" as const,
				reason: "",
			},
		];
		expect(projectPlaybackSecToRawTimeline(clips, trims, 2, speed)).toBeCloseTo(6, 8);
		for (const raw of [0, 2, 8, 14, 20, 25]) {
			const programme = projectRawTimelineSecToPlayback(clips, trims, raw, speed);
			expect(projectPlaybackSecToRawTimeline(clips, trims, programme, speed)).toBeCloseTo(raw, 8);
		}
	});
	it("keeps the entire soundtrack while adding, shortening, reordering and deleting visuals", () => {
		const original = audioProject();
		const first = visual("first", 0, 5);
		const second = visual("second", 5, 8);
		const added = withClipsChanged(original, [first, second]);
		const changed = withClipsChanged(added, [
			second,
			{ ...first, sourceEndSec: 2, timelineEndSec: 2 },
		]);
		const removed = withClipsChanged(changed, []);
		for (const document of [added, changed, removed]) {
			expect(document.audioTracks).toEqual(original.audioTracks);
			expect(audioProgrammeDuration(document)).toBe(90);
			expect(document.audioTracks[0].clipId).toBeUndefined();
		}
	});

	it("does not truncate the soundtrack when a shorter visual duration is probed", () => {
		const document = withClipsChanged(audioProject(), [visual("unprobed", 0, 60)]);
		const measured = applyProbedDuration(document, "unprobed", 6);
		expect(measured.timeline.clips[0].timelineEndSec).toBe(6);
		expect(audioProgrammeDuration(measured)).toBe(90);
	});

	it("persists timeline placement when saved and reopened", () => {
		const document = audioProject();
		const reopened = documentSchema.parse(JSON.parse(JSON.stringify(document)));
		expect(reopened.audioTracks[0].timelineLocked).toBe(true);
		expect(audioProgrammeDuration(withClipsChanged(reopened, [visual("one", 0, 4)]))).toBe(90);
	});

	it("edits in/out, placement and gain as one document change using the on-disk source duration", () => {
		const document = audioProject();
		const updated = editAudioFirstTrack(document, document.audioTracks[0].id, {
			startSec: 3,
			inSec: 12,
			outSec: 42,
			gainDb: -9,
		});
		expect(updated.audioTracks[0]).toMatchObject({
			startMs: 3000,
			endMs: 33000,
			offsetMs: 12000,
			gainDb: -9,
			timelineLocked: true,
		});
		expect(document.audioTracks[0].endMs).toBe(90_000);
	});

	it.each([
		{ startSec: 0, inSec: 0, outSec: 91, gainDb: 0 },
		{ startSec: 0, inSec: 12, outSec: 12, gainDb: 0 },
		{ startSec: -1, inSec: 0, outSec: 10, gainDb: 0 },
		{ startSec: 0, inSec: 0, outSec: 10, gainDb: 13 },
		{ startSec: Number.NaN, inSec: 0, outSec: 10, gainDb: 0 },
	])("rejects invalid source windows and gains (%j)", (edit) => {
		const document = audioProject();
		expect(() => editAudioFirstTrack(document, document.audioTracks[0].id, edit)).toThrow();
	});
});
