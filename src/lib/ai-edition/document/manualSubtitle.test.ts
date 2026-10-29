import { describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema } from "../schema";
import { addManualSubtitle } from "./manualSubtitle";

function document() {
	const doc = createEmptyDocument({ projectId: "test", title: "Test" });
	doc.timeline.clips = [
		{
			id: "one",
			assetId: "a",
			sourceStartSec: 10,
			sourceEndSec: 15,
			timelineStartSec: 0,
			timelineEndSec: 5,
			wordRefs: [],
			origin: "user",
			reason: "Test fixture",
		},
		{
			id: "two",
			assetId: "b",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 5,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "Test fixture",
		},
	];
	return doc;
}
describe("manual subtitles", () => {
	it("anchors across clips, preserves user text, and survives schema round-trip", () => {
		const before = addManualSubtitle(document(), { text: "First", startSec: 0, endSec: 1 });
		const next = documentSchema.parse(
			addManualSubtitle(before, { text: "  교육자료 자막  ", startSec: 4, endSec: 7 }),
		);
		expect(next.annotations).toHaveLength(3);
		expect(next.annotations[0]).toEqual(before.annotations[0]);
		expect(next.annotations[1]).toMatchObject({
			content: "교육자료 자막",
			clipId: "one",
			sourceStartSec: 14,
			sourceEndSec: 15,
			style: { fontSize: 57 },
		});
		expect(next.annotations[2]).toMatchObject({
			clipId: "two",
			sourceStartSec: 0,
			sourceEndSec: 2,
		});
		expect(before.annotations).toHaveLength(1);
	});
	it("clamps the subtitle at the last clip", () => {
		expect(
			addManualSubtitle(document(), { text: "End", startSec: 9, endSec: 15 }).annotations[0].endMs,
		).toBe(10000);
	});
	it.each([
		{ text: "", startSec: 0, endSec: 1 },
		{ text: "x", startSec: 10, endSec: 11 },
		{ text: "x", startSec: -1, endSec: 1 },
		{ text: "x", startSec: 2, endSec: 2 },
		{ text: "x", startSec: 0, endSec: Number.NaN },
	])("rejects unusable input %j", (input) => {
		expect(() => addManualSubtitle(document(), input)).toThrow();
	});
});
