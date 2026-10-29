import { type AnnotationTextAnimation, normalizeTextAnimation } from "../annotations/textAnimation";
import { type AxcutAnnotationRegion, type AxcutDocument, annotationRegionSchema } from "../schema";
import {
	anchorRegionsWithDerivedMs,
	coalesceRegionsForRuler,
	resolvePillIds,
} from "../timeline/timelineMap";
import { createId } from "./ids";

/**
 * Subtitles typed into Edit: text over the picture, of two kinds — a TITLE (AutoVeo's
 * "타이틀": large, in the middle, coming in with an effect) and a CAPTION (AutoVeo's regular
 * subtitle: at the bottom, 57 px on a 1080 frame, across 85% of it). Each kind has a look the
 * project keeps — size, colour, box, place, effect, length — so a new one matches the ones
 * before it, and the look can be put back on all of them at once.
 *
 * A subtitle is a text annotation marked with its kind: it is drawn by the same compositor
 * path as every annotation, in the preview and in the export alike, and edited, moved and
 * deleted on the timeline like one. Only the effects that path draws are offered.
 */

export type SubtitleKind = "caption" | "title";
export type SubtitleBox = "none" | "soft" | "solid";
export type SubtitlePosition = "bottom" | "middle" | "top";

export interface SubtitleStyle {
	/** Pixels on a 1080-high frame, as every annotation's font size is. */
	fontSize: number;
	fontFamily: string;
	bold: boolean;
	color: string;
	box: SubtitleBox;
	boxColor: string;
	position: SubtitlePosition;
	animation: AnnotationTextAnimation;
	/** How long a new one lasts, in seconds. */
	durationSec: number;
}

/** AutoVeo's sizes: 57 px for a caption, 150 for a title — a little less here, as a title
 *  holds no second line of its own. */
export const SUBTITLE_PRESETS: Record<SubtitleKind, SubtitleStyle> = {
	caption: {
		fontSize: 57,
		fontFamily: "Malgun Gothic",
		bold: true,
		color: "#ffffff",
		box: "soft",
		boxColor: "#000000",
		position: "bottom",
		animation: "fade",
		durationSec: 3,
	},
	title: {
		fontSize: 120,
		fontFamily: "Malgun Gothic",
		bold: true,
		color: "#ffffff",
		box: "none",
		boxColor: "#000000",
		position: "middle",
		animation: "rise",
		durationSec: 3.5,
	},
};

export const SUBTITLE_KIND_LABELS: Record<SubtitleKind, string> = {
	caption: "일반 자막",
	title: "타이틀",
};

/**
 * The effects offered, named the way AutoVeo names the title effects each one plays like.
 * Only these: the compositor that draws the preview and the export plays no others.
 */
export const SUBTITLE_EFFECTS: Array<{
	value: AnnotationTextAnimation;
	label: string;
	description: string;
}> = [
	{ value: "none", label: "효과 없음", description: "바로 나타납니다." },
	{ value: "fade", label: "페이드", description: "서서히 나타납니다. 일반 자막에 무난합니다." },
	{ value: "rise", label: "페이드 업", description: "아래에서 떠오르며 나타납니다." },
	{ value: "pop", label: "스케일 펀치", description: "크게 들어왔다가 제자리를 잡습니다." },
	{ value: "slide-left", label: "옆에서 밀기", description: "옆에서 밀려 들어옵니다." },
	{ value: "typewriter", label: "타자기", description: "왼쪽부터 한 글자씩 드러납니다." },
	{ value: "pulse", label: "강조 펄스", description: "나타난 뒤 살짝 커졌다 돌아옵니다." },
];

export const SUBTITLE_FONTS = [
	{ value: "Malgun Gothic", label: "맑은 고딕" },
	{ value: "Gulim", label: "굴림" },
	{ value: "Dotum", label: "돋움" },
	{ value: "Batang", label: "바탕" },
	{ value: "Gungsuh", label: "궁서" },
	{ value: "Inter", label: "Inter" },
	{ value: "Arial", label: "Arial" },
	{ value: "Georgia", label: "Georgia" },
	{ value: "Impact", label: "Impact" },
];

const BOX_ALPHA: Record<SubtitleBox, number> = { none: 0, soft: 0.45, solid: 0.85 };
/** AutoVeo's caption column: 85% of the frame's width. */
const WIDTH_PCT = 85;
const SIDE_PCT = (100 - WIDTH_PCT) / 2;

const STYLES_KEY = "subtitleStyles";

function isHexColor(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function readStyle(value: unknown, fallback: SubtitleStyle): SubtitleStyle {
	if (!value || typeof value !== "object") return fallback;
	const raw = value as Partial<Record<keyof SubtitleStyle, unknown>>;
	const number = (v: unknown, low: number, high: number, otherwise: number) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(high, Math.max(low, v)) : otherwise;
	return {
		fontSize: number(raw.fontSize, 12, 300, fallback.fontSize),
		fontFamily:
			typeof raw.fontFamily === "string" && raw.fontFamily.trim()
				? raw.fontFamily
				: fallback.fontFamily,
		bold: typeof raw.bold === "boolean" ? raw.bold : fallback.bold,
		color: isHexColor(raw.color) ? raw.color : fallback.color,
		box: raw.box === "none" || raw.box === "soft" || raw.box === "solid" ? raw.box : fallback.box,
		boxColor: isHexColor(raw.boxColor) ? raw.boxColor : fallback.boxColor,
		position:
			raw.position === "bottom" || raw.position === "middle" || raw.position === "top"
				? raw.position
				: fallback.position,
		animation:
			raw.animation === undefined ? fallback.animation : normalizeTextAnimation(raw.animation),
		durationSec: number(raw.durationSec, 0.5, 30, fallback.durationSec),
	};
}

/** The project's look for each kind: what the Subtitles panel last set, else the presets. */
export function getSubtitleStyles(
	document: AxcutDocument | null | undefined,
): Record<SubtitleKind, SubtitleStyle> {
	const stored = (document?.legacyEditor as Record<string, unknown> | null | undefined)?.[
		STYLES_KEY
	] as Partial<Record<SubtitleKind, unknown>> | undefined;
	return {
		caption: readStyle(stored?.caption, SUBTITLE_PRESETS.caption),
		title: readStyle(stored?.title, SUBTITLE_PRESETS.title),
	};
}

export function patchSubtitleStyle(
	document: AxcutDocument,
	kind: SubtitleKind,
	patch: Partial<SubtitleStyle>,
): AxcutDocument {
	const styles = getSubtitleStyles(document);
	const legacy = (document.legacyEditor as Record<string, unknown> | null) ?? {};
	return {
		...document,
		legacyEditor: {
			...legacy,
			[STYLES_KEY]: { ...styles, [kind]: readStyle({ ...styles[kind], ...patch }, styles[kind]) },
		},
	};
}

function rgba(hex: string, alpha: number): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * Where a subtitle's box sits, in % of the picture: across the middle 85%, with room for a few
 * lines. A caption keeps AutoVeo's distance from the bottom — more on a tall frame, where the
 * platform's own buttons sit.
 */
export function subtitleBox(
	style: Pick<SubtitleStyle, "position" | "fontSize">,
	aspect: number,
): { x: number; y: number; width: number; height: number } {
	// Three lines of text, with the box's own padding, as a share of the frame's height.
	const height = Math.min(
		60,
		Math.max(14, (style.fontSize * aspectScale(aspect) * 1.5 * 3 * 100) / 1080),
	);
	const margin = aspect < 1 ? 16 : 8.5;
	const y =
		style.position === "bottom"
			? 100 - margin - height
			: style.position === "top"
				? margin
				: 50 - height / 2;
	return { x: SIDE_PCT, y: Math.max(0, y), width: WIDTH_PCT, height };
}

/**
 * A font size is stored against the frame's HEIGHT; AutoVeo sizes against the short side. On
 * a tall frame the two differ, so the stored size shrinks by width / height to look the same.
 */
function aspectScale(aspect: number): number {
	return Number.isFinite(aspect) && aspect > 0 && aspect < 1 ? aspect : 1;
}

/** Which edge of its box the text keeps to, as the compositor pins captions. */
export function subtitleVerticalAlign(position: SubtitlePosition): "top" | "center" | "bottom" {
	return position === "bottom" ? "bottom" : position === "top" ? "top" : "center";
}

export function isSubtitle(region: Pick<AxcutAnnotationRegion, "id" | "subtitleKind">): boolean {
	// Subtitles typed before kinds existed were all captions, and carry the id prefix.
	return region.subtitleKind !== undefined || region.id.startsWith("subtitle_");
}

export function subtitleKindOf(
	region: Pick<AxcutAnnotationRegion, "id" | "subtitleKind">,
): SubtitleKind {
	return region.subtitleKind ?? "caption";
}

/** The look of `style` as annotation fields: its box, its text and its effect. */
function styledRegionFields(style: SubtitleStyle, aspect: number) {
	const box = subtitleBox(style, aspect);
	return {
		position: { x: box.x, y: box.y },
		size: { width: box.width, height: box.height },
		style: {
			fontSize: Math.round(style.fontSize * aspectScale(aspect)),
			fontFamily: style.fontFamily,
			fontWeight: style.bold ? ("bold" as const) : ("normal" as const),
			fontStyle: "normal" as const,
			textDecoration: "none" as const,
			color: style.color,
			backgroundColor:
				style.box === "none" ? "transparent" : rgba(style.boxColor, BOX_ALPHA[style.box]),
			textAlign: "center" as const,
			textAnimation: style.animation,
		},
	};
}

export interface SubtitleInput {
	kind?: SubtitleKind;
	text: string;
	startSec: number;
	endSec: number;
}

/** Where the programme ends on the raw ruler: nothing can be subtitled past it. */
function programmeEndSec(document: AxcutDocument): number {
	return Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
}

/**
 * Adds subtitles in the project's look for their kind, each anchored to the clips under it the
 * way every annotation is. One that would run into the next subtitle ends where it starts.
 * Returns the id of each one's first fragment — what the timeline selects.
 */
export function addSubtitles(
	document: AxcutDocument,
	inputs: SubtitleInput[],
	aspect = 16 / 9,
): { document: AxcutDocument; ids: string[] } {
	const end = programmeEndSec(document);
	if (end <= 0 || !document.timeline.clips.length)
		throw new Error("자막을 넣을 클립을 먼저 추가해 주세요.");
	const styles = getSubtitleStyles(document);
	let annotations = [...document.annotations];
	let zIndex = Math.max(0, ...annotations.map((region) => region.zIndex));
	const ids: string[] = [];
	for (const input of [...inputs].sort((left, right) => left.startSec - right.startSec)) {
		const text = input.text.trim();
		if (!text) throw new Error("자막 내용을 입력해 주세요.");
		const kind = input.kind ?? "caption";
		if (
			!Number.isFinite(input.startSec) ||
			!Number.isFinite(input.endSec) ||
			input.startSec < 0 ||
			input.endSec <= input.startSec
		)
			throw new Error("자막 시작·종료 시간을 확인해 주세요.");
		if (input.startSec >= end) throw new Error("자막이 영상이 끝난 뒤에서 시작합니다.");
		// Subtitles take turns, as on one track: started inside another, one waits for it to end,
		// and it ends where the next one starts.
		const subtitles = annotations.filter(isSubtitle);
		let startSec = input.startSec;
		for (let covering = coveringAt(subtitles, startSec); covering; ) {
			startSec = covering.endMs / 1000;
			covering = coveringAt(subtitles, startSec);
		}
		if (startSec > end - 0.1) throw new Error("자막이 들어갈 자리가 영상 끝까지 없습니다.");
		const next = subtitles
			.filter((region) => region.startMs / 1000 > startSec + 0.001)
			.reduce((earliest, region) => Math.min(earliest, region.startMs / 1000), end);
		const endSec = Math.min(startSec + (input.endSec - input.startSec), next, end);
		const region = annotationRegionSchema.parse({
			id: createId("subtitle"),
			type: "text",
			content: text,
			startMs: Math.round(startSec * 1000),
			endMs: Math.round(Math.max(startSec + 0.1, endSec) * 1000),
			subtitleKind: kind,
			zIndex: ++zIndex,
			...styledRegionFields(styles[kind], aspect),
		});
		const anchored = anchorRegionsWithDerivedMs([region], document.timeline.clips, () =>
			createId("subtitle"),
		) as AxcutAnnotationRegion[];
		ids.push(anchored[0]?.id ?? region.id);
		annotations = [...annotations, ...anchored];
	}
	return { document: { ...document, annotations }, ids };
}

/** The subtitle showing at `sec`, if any. */
function coveringAt(
	subtitles: AxcutAnnotationRegion[],
	sec: number,
): AxcutAnnotationRegion | undefined {
	return subtitles.find(
		(region) => region.startMs / 1000 <= sec + 0.001 && region.endMs / 1000 > sec + 0.001,
	);
}

/** One subtitle as the list shows it: its fragments merged back into the span it covers. */
export interface SubtitleEntry {
	ids: string[];
	kind: SubtitleKind;
	text: string;
	startSec: number;
	endSec: number;
}

export function subtitleEntries(document: AxcutDocument | null | undefined): SubtitleEntry[] {
	if (!document) return [];
	return coalesceRegionsForRuler(document.annotations.filter(isSubtitle))
		.map((pill) => ({
			ids: pill.ids,
			kind: subtitleKindOf(pill.member),
			text: pill.member.content || pill.member.textContent || "",
			startSec: pill.start,
			endSec: pill.end,
		}))
		.sort((left, right) => left.startSec - right.startSec);
}

/** Retypes a subtitle — every fragment of it, so it stays one. */
export function setSubtitleText(document: AxcutDocument, id: string, text: string): AxcutDocument {
	const content = text.trim();
	if (!content) throw new Error("자막 내용을 입력해 주세요.");
	const under = new Set(resolvePillIds(document.annotations, id));
	if (!document.annotations.some((region) => under.has(region.id))) return document;
	return {
		...document,
		annotations: document.annotations.map((region) =>
			under.has(region.id) ? { ...region, content, textContent: "" } : region,
		),
	};
}

/**
 * Puts the project's current look for their kind back on every subtitle of that kind, keeping
 * each one's text and timing — what "모두에 적용" does after the look changed.
 */
export function restyleSubtitles(
	document: AxcutDocument,
	kind: SubtitleKind,
	aspect = 16 / 9,
): AxcutDocument {
	const fields = styledRegionFields(getSubtitleStyles(document)[kind], aspect);
	let changed = false;
	const annotations = document.annotations.map((region) => {
		if (!isSubtitle(region) || subtitleKindOf(region) !== kind) return region;
		changed = true;
		return {
			...region,
			subtitleKind: kind,
			position: fields.position,
			size: fields.size,
			style: { ...region.style, ...fields.style },
		};
	});
	return changed ? { ...document, annotations } : document;
}

// ─── Reading subtitle files and pasted text ─────────────────────────

export interface SubtitleCue {
	startSec: number;
	endSec: number;
	text: string;
}

const TIMESTAMP = /^(?:(\d{1,}):)?([0-5]?\d):([0-5]\d)[,.](\d{1,3})$/;

function seconds(stamp: string): number | null {
	const match = TIMESTAMP.exec(stamp.trim());
	if (!match) return null;
	return (
		Number(match[1] ?? 0) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(match[4].padEnd(3, "0")) / 1000
	);
}

function cleanCue(text: string): string {
	return text
		.replace(/<\/?(?:b|i|u|c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/gi, "")
		.replace(/\{\\[^}]*\}/g, "")
		.trim();
}

/**
 * Reads SRT or WebVTT cues, or — for plain text — one subtitle per non-empty line. Adapted from
 * AutoVeo's caption import. Cues keep their own times; lines have none yet.
 */
export function parseSubtitleText(input: string): { cues: SubtitleCue[] } | { lines: string[] } {
	const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
	if (!text) return { lines: [] };
	const timing = /^(\S+)\s+-->\s+(\S+)/;
	if (!text.split("\n").some((line) => timing.test(line.trim())))
		return {
			lines: text
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		};
	const cues: SubtitleCue[] = [];
	for (const block of text.split(/\n[ \t]*\n+/)) {
		const lines = block.split("\n").map((line) => line.trim());
		const at = lines.findIndex((line) => timing.test(line));
		if (at < 0) continue;
		const [, from, to] = timing.exec(lines[at]) ?? [];
		const startSec = seconds(from ?? "");
		const endSec = seconds(to ?? "");
		const body = cleanCue(lines.slice(at + 1).join("\n"));
		if (startSec === null || endSec === null || endSec <= startSec || !body) continue;
		cues.push({ startSec, endSec, text: body });
	}
	return { cues };
}

/**
 * Lines with no times of their own, laid one after another from `startSec`: each lasts in
 * proportion to its length, as long as it takes to read — no less than 1.5 s, no more than 6.
 */
export function timeLines(lines: string[], startSec: number): SubtitleCue[] {
	let cursor = Math.max(0, startSec);
	return lines.map((line) => {
		const length = [...line.replace(/\s+/g, "")].length;
		const duration = Math.round(Math.min(6, Math.max(1.5, 0.8 + length * 0.12)) * 10) / 10;
		const cue = { startSec: cursor, endSec: cursor + duration, text: line };
		cursor += duration;
		return cue;
	});
}
