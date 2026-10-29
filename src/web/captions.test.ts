import { describe, expect, it } from "vitest";
import { activeCaptionText, parseSrt, stringifySrt, type WebCaption } from "./captions";

const sample =
	"1\n00:00:00,250 --> 00:00:02,000\n안녕하세요\n두 번째 줄\n\n2\n00:00:01,500 --> 00:00:03,125\n다음 자막\n";

function cue(startMs: number, endMs: number, text = "자막"): WebCaption {
	return { id: `cue-${startMs}`, text, startMs, endMs, timestampMs: null, confidence: null };
}

describe("browser SRT subtitles", () => {
	it("imports UTF-8 BOM, Windows newlines, multiple lines and overlapping cues", () => {
		const captions = parseSrt(`\uFEFF${sample.replace(/\n/g, "\r\n")}`);
		expect(captions).toHaveLength(2);
		expect(captions[0]).toMatchObject({
			text: "안녕하세요\n두 번째 줄",
			startMs: 250,
			endMs: 2_000,
		});
		expect(captions[1]).toMatchObject({ text: "다음 자막", startMs: 1_500, endMs: 3_125 });
		expect(captions[0].id).not.toBe(captions[1].id);
	});

	it("accepts unnumbered cues and sorts them by their actual start time", () => {
		const captions = parseSrt(
			"00:00:03.000 --> 00:00:04.000\nLater\n\n00:00:01,000 --> 00:00:02,000\nEarlier",
		);
		expect(captions.map((caption) => caption.text)).toEqual(["Earlier", "Later"]);
	});

	it("preserves millisecond timing, Unicode text and line breaks in SRT round trips", () => {
		const captions = parseSrt(sample);
		const restored = parseSrt(stringifySrt(captions));
		expect(restored.map(({ id: _id, ...caption }) => caption)).toEqual(
			captions.map(({ id: _id, ...caption }) => caption),
		);
		expect(stringifySrt([])).toBe("");
	});

	it("exports editable paragraph gaps as valid SRT line breaks", () => {
		const result = parseSrt(stringifySrt([cue(0, 1_000, "첫 줄\n\n \n둘째 줄")]));
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("첫 줄\n둘째 줄");
	});

	it("includes the start, excludes the end and combines overlapping cues", () => {
		const captions = parseSrt(sample);
		expect(activeCaptionText(captions, 0.249)).toBe("");
		expect(activeCaptionText(captions, 0.25)).toBe("안녕하세요\n두 번째 줄");
		expect(activeCaptionText(captions, 1.5)).toBe("안녕하세요\n두 번째 줄\n다음 자막");
		expect(activeCaptionText(captions, 2)).toBe("다음 자막");
		expect(activeCaptionText(captions, 3.125)).toBe("");
		expect(activeCaptionText(captions, Number.NaN)).toBe("");
		expect(activeCaptionText([cue(1_001, 2_001)], 1.001)).toBe("자막");
		expect(activeCaptionText([cue(1, 1_001)], 1.001)).toBe("");
	});

	it.each([
		"",
		"not a subtitle",
		"1\n00:00:00,000 --> 00:00:01,000\n",
		"1\n00:61:00,000 --> 00:62:00,000\nInvalid minutes",
		"1\n00:00:02,000 --> 00:00:01,000\nReversed",
		"1\n00:00:01,000 --> 00:00:01,000\nEmpty range",
		"1\n24:00:00,000 --> 24:00:00,001\nBeyond 24 hours",
	])("rejects malformed input without importing a partial transcript (%s)", (input) => {
		expect(() => parseSrt(input)).toThrow();
	});

	it("rejects oversized files, oversized cue text and too many cues", () => {
		expect(() => parseSrt(" ".repeat(5_000_001))).toThrow("너무 큽니다");
		expect(() => parseSrt(`00:00:00,000 --> 00:00:01,000\n${"a".repeat(5_001)}`)).toThrow(
			"5,000자",
		);
		expect(() => parseSrt("00:00:00,000 --> 00:00:01,000\na\n\n".repeat(10_001))).toThrow(
			"10,000개",
		);
	});

	it("refuses invalid data on export and rounds sub-millisecond timing with rollover", () => {
		expect(() => stringifySrt([cue(Number.NaN, 1_000)])).toThrow();
		expect(() => stringifySrt([cue(1_000, 2_000, " ")])).toThrow();
		expect(() => stringifySrt([cue(1_000.1, 1_000.2)])).toThrow("1밀리초");
		expect(stringifySrt([cue(59_999.6, 61_000.2)])).toContain("00:01:00,000 --> 00:01:01,000");
	});
});
