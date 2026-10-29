import { describe, expect, it } from "vitest";
import { type AxcutClip, createEmptyDocument, documentSchema } from "../schema";
import {
	addSubtitles,
	getSubtitleStyles,
	parseSubtitleText,
	patchSubtitleStyle,
	restyleSubtitles,
	SUBTITLE_PRESETS,
	setSubtitleText,
	subtitleBox,
	subtitleEntries,
	timeLines,
} from "./subtitles";

function clip(id: string, start: number, end: number): AxcutClip {
	return {
		id,
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: end - start,
		timelineStartSec: start,
		timelineEndSec: end,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

/** Two clips, 0–5 s and 5–10 s. */
function document() {
	const doc = createEmptyDocument({ projectId: "p", title: "Subtitles" });
	doc.timeline.clips = [clip("one", 0, 5), clip("two", 5, 10)];
	return doc;
}

describe("subtitles", () => {
	it("put a caption at the bottom, across 85% of the frame, in AutoVeo's size", () => {
		const { document: doc, ids } = addSubtitles(document(), [
			{ kind: "caption", text: "  안녕하세요  ", startSec: 1, endSec: 4 },
		]);
		const [caption] = doc.annotations;
		expect(ids).toEqual([caption.id]);
		expect(caption).toMatchObject({
			type: "text",
			content: "안녕하세요",
			subtitleKind: "caption",
			startMs: 1000,
			endMs: 4000,
			clipId: "one",
			position: { x: 7.5 },
			size: { width: 85 },
			style: {
				fontSize: 57,
				fontWeight: "bold",
				textAlign: "center",
				textAnimation: "fade",
				backgroundColor: "rgba(0, 0, 0, 0.45)",
			},
		});
		// Its box ends 8.5% above the frame's bottom.
		expect(caption.position.y + caption.size.height).toBeCloseTo(91.5, 5);
		expect(documentSchema.parse(doc).annotations[0].subtitleKind).toBe("caption");
	});

	it("put a title in the middle, large, rising in", () => {
		const { document: doc } = addSubtitles(document(), [
			{ kind: "title", text: "여행의 시작", startSec: 0, endSec: 3.5 },
		]);
		const [title] = doc.annotations;
		expect(title).toMatchObject({
			subtitleKind: "title",
			style: { fontSize: 120, textAnimation: "rise", backgroundColor: "transparent" },
		});
		expect(title.position.y + title.size.height / 2).toBeCloseTo(50, 5);
	});

	it("keep AutoVeo's size on a tall frame, and sit higher above its bottom", () => {
		const { document: doc } = addSubtitles(
			document(),
			[{ kind: "caption", text: "세로", startSec: 0, endSec: 2 }],
			9 / 16,
		);
		const [caption] = doc.annotations;
		// Stored against the frame's height: 57 × 9/16, which draws 57 px on a 1080-wide frame.
		expect(caption.style.fontSize).toBe(32);
		expect(caption.position.y + caption.size.height).toBeCloseTo(84, 5);
		expect(subtitleBox({ position: "top", fontSize: 57 }, 16 / 9).y).toBe(8.5);
	});

	it("end where the next one starts, and where the video ends", () => {
		let doc = addSubtitles(document(), [{ text: "둘째", startSec: 6, endSec: 8 }]).document;
		doc = addSubtitles(doc, [
			{ text: "첫째", startSec: 4, endSec: 9 },
			{ text: "끝", startSec: 9, endSec: 15 },
		]).document;
		expect(subtitleEntries(doc).map((entry) => [entry.text, entry.startSec, entry.endSec])).toEqual(
			[
				["첫째", 4, 6],
				["둘째", 6, 8],
				["끝", 9, 10],
			],
		);
		// "첫째" crosses from the first clip into the second: two fragments, one entry.
		expect(subtitleEntries(doc)[0].ids).toHaveLength(2);
	});

	it("take turns: one started inside another waits for it to end", () => {
		let doc = addSubtitles(document(), [{ text: "먼저", startSec: 2, endSec: 5 }]).document;
		doc = addSubtitles(doc, [{ text: "나중", startSec: 3, endSec: 4 }]).document;
		expect(subtitleEntries(doc).map((entry) => [entry.text, entry.startSec, entry.endSec])).toEqual(
			[
				["먼저", 2, 5],
				["나중", 5, 6],
			],
		);
		const full = addSubtitles(document(), [{ text: "끝까지", startSec: 0, endSec: 10 }]).document;
		expect(() => addSubtitles(full, [{ text: "자리 없음", startSec: 4, endSec: 5 }])).toThrow(
			"자막이 들어갈 자리가 영상 끝까지 없습니다.",
		);
	});

	it("refuse what cannot be shown", () => {
		expect(() => addSubtitles(document(), [{ text: " ", startSec: 0, endSec: 1 }])).toThrow();
		expect(() => addSubtitles(document(), [{ text: "x", startSec: 12, endSec: 13 }])).toThrow();
		expect(() => addSubtitles(document(), [{ text: "x", startSec: 3, endSec: 3 }])).toThrow();
		const empty = createEmptyDocument({ projectId: "p", title: "Empty" });
		expect(() => addSubtitles(empty, [{ text: "x", startSec: 0, endSec: 1 }])).toThrow(
			"자막을 넣을 클립을 먼저 추가해 주세요.",
		);
	});

	it("retype every fragment of one", () => {
		const { document: doc, ids } = addSubtitles(document(), [
			{ text: "고칠 자막", startSec: 4, endSec: 7 },
		]);
		const fixed = setSubtitleText(doc, ids[0], "고친 자막");
		expect(fixed.annotations.map((region) => region.content)).toEqual(["고친 자막", "고친 자막"]);
		expect(subtitleEntries(fixed)).toHaveLength(1);
		expect(() => setSubtitleText(doc, ids[0], "  ")).toThrow();
	});

	it("keep a look per kind, and put it back on all of that kind", () => {
		const { document: doc } = addSubtitles(document(), [
			{ kind: "caption", text: "자막", startSec: 0, endSec: 2 },
			{ kind: "title", text: "타이틀", startSec: 3, endSec: 4 },
		]);
		const yellow = patchSubtitleStyle(doc, "caption", {
			color: "#ffe14d",
			box: "none",
			position: "top",
			fontSize: 9999,
			animation: "typewriter",
		});
		expect(getSubtitleStyles(yellow).caption).toMatchObject({
			color: "#ffe14d",
			box: "none",
			fontSize: 300,
			animation: "typewriter",
		});
		expect(getSubtitleStyles(yellow).title).toEqual(SUBTITLE_PRESETS.title);
		const restyled = restyleSubtitles(yellow, "caption");
		const [caption, title] = restyled.annotations;
		expect(caption).toMatchObject({
			content: "자막",
			startMs: 0,
			style: { color: "#ffe14d", backgroundColor: "transparent", textAnimation: "typewriter" },
			position: { y: 8.5 },
		});
		expect(title).toEqual(doc.annotations[1]);
		// Nonsense stored by hand reads back as the preset.
		const broken = {
			...doc,
			legacyEditor: { subtitleStyles: { caption: { color: "red", box: "glass" } } },
		};
		expect(getSubtitleStyles(broken).caption).toEqual(SUBTITLE_PRESETS.caption);
	});
});

describe("reading subtitles", () => {
	it("keeps the times of SRT and VTT cues, cleaned of tags", () => {
		const srt =
			"1\n00:00:01,000 --> 00:00:03,500\n<i>첫 줄</i>\n\n2\n00:00:04,000 --> 00:00:06,000\n둘째\n줄";
		expect(parseSubtitleText(srt)).toEqual({
			cues: [
				{ startSec: 1, endSec: 3.5, text: "첫 줄" },
				{ startSec: 4, endSec: 6, text: "둘째\n줄" },
			],
		});
		const vtt = "WEBVTT\n\n00:01.200 --> 00:02.000\nHello";
		expect(parseSubtitleText(vtt)).toEqual({ cues: [{ startSec: 1.2, endSec: 2, text: "Hello" }] });
	});

	it("takes plain text a line at a time, each as long as it takes to read", () => {
		const parsed = parseSubtitleText(
			"﻿짧다\r\n\r\n이 줄은 조금 더 길어서 읽는 데 시간이 걸립니다\n",
		);
		expect(parsed).toEqual({ lines: ["짧다", "이 줄은 조금 더 길어서 읽는 데 시간이 걸립니다"] });
		if (!("lines" in parsed)) throw new Error("lines expected");
		expect(timeLines(parsed.lines, 2)).toEqual([
			{ startSec: 2, endSec: 3.5, text: "짧다" },
			{ startSec: 3.5, endSec: 6.6, text: "이 줄은 조금 더 길어서 읽는 데 시간이 걸립니다" },
		]);
	});
});
