/** Compatible with Remotion's Caption data, with an ID for editing and persistence. */
export type WebCaption = {
	id: string;
	text: string;
	startMs: number;
	endMs: number;
	timestampMs: number | null;
	confidence: number | null;
};

export type WebCaptionStyle = {
	/** Relative to the output height, so preview and export use the same size. */
	fontSize: number;
	color: string;
	position: "top" | "center" | "bottom";
	background: boolean;
};

export const DEFAULT_CAPTION_STYLE: WebCaptionStyle = Object.freeze({
	fontSize: 0.042,
	color: "#ffffff",
	position: "bottom",
	background: true,
});

const MAX_CAPTIONS = 10_000;
const MAX_TEXT_LENGTH = 5_000;
const MAX_SRT_LENGTH = 5_000_000;
const MAX_TIME_MS = 86_400_000;
const TIMING_LINE = /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})$/;

function parseTimestamp(value: string): number {
	const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
	if (!match) throw new Error("SRT 시간은 시:분:초,밀리초 형식이어야 합니다.");
	const [, hours, minutes, seconds, milliseconds] = match;
	const result =
		Number(hours) * 3_600_000 +
		Number(minutes) * 60_000 +
		Number(seconds) * 1_000 +
		Number(milliseconds);
	if (result > MAX_TIME_MS) throw new Error("자막 시간은 24시간 이내여야 합니다.");
	return result;
}

function validateCue(caption: Pick<WebCaption, "text" | "startMs" | "endMs">): void {
	if (
		!Number.isFinite(caption.startMs) ||
		!Number.isFinite(caption.endMs) ||
		caption.startMs < 0 ||
		caption.endMs > MAX_TIME_MS ||
		caption.endMs <= caption.startMs
	) {
		throw new Error("자막 종료 시간은 시작 시간보다 늦어야 하며 24시간 이내여야 합니다.");
	}
	if (!caption.text.trim() || caption.text.length > MAX_TEXT_LENGTH) {
		throw new Error("자막 내용은 1자 이상 5,000자 이하여야 합니다.");
	}
}

/** Parse a plain-text SRT file. Overlapping cues are valid and remain separate. */
export function parseSrt(input: string): WebCaption[] {
	if (input.length > MAX_SRT_LENGTH)
		throw new Error("SRT 파일이 너무 큽니다. 500만 자 이하로 나눠 주세요.");
	const normalized = input
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!normalized) throw new Error("SRT 파일에 자막이 없습니다.");
	const blocks = normalized.split(/\n(?:[\t ]*\n)+/);
	if (blocks.length > MAX_CAPTIONS) throw new Error("자막은 최대 10,000개까지 가져올 수 있습니다.");
	return blocks
		.map((block, index): WebCaption => {
			const lines = block.trim().split("\n");
			// A sequence number is customary, but some subtitle tools omit it.
			const timingIndex = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
			const timing = TIMING_LINE.exec(lines[timingIndex]?.trim() ?? "");
			if (!timing) throw new Error(`${index + 1}번째 자막의 SRT 시간 형식이 올바르지 않습니다.`);
			const caption: WebCaption = {
				id: crypto.randomUUID(),
				text: lines
					.slice(timingIndex + 1)
					.join("\n")
					.trim(),
				startMs: parseTimestamp(timing[1]),
				endMs: parseTimestamp(timing[2]),
				timestampMs: null,
				confidence: null,
			};
			validateCue(caption);
			return caption;
		})
		.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function formatTimestamp(milliseconds: number): string {
	const rounded = Math.round(milliseconds);
	const hours = Math.floor(rounded / 3_600_000);
	const minutes = Math.floor((rounded % 3_600_000) / 60_000);
	const seconds = Math.floor((rounded % 60_000) / 1_000);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(rounded % 1_000).padStart(3, "0")}`;
}

/** SRT carries cue text and timing; visual styling stays in the project backup. */
export function stringifySrt(captions: readonly WebCaption[]): string {
	if (captions.length > MAX_CAPTIONS)
		throw new Error("자막은 최대 10,000개까지 저장할 수 있습니다.");
	const result = [...captions]
		.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
		.map((caption, index) => {
			validateCue(caption);
			if (Math.round(caption.endMs) <= Math.round(caption.startMs)) {
				throw new Error("SRT 자막의 재생 구간은 최소 1밀리초여야 합니다.");
			}
			// Blank lines delimit cues in SRT; collapse paragraph gaps to valid line breaks.
			const text = caption.text
				.replace(/\r\n?/g, "\n")
				.replace(/\n(?:[\t ]*\n)+/g, "\n")
				.trim();
			return `${index + 1}\n${formatTimestamp(caption.startMs)} --> ${formatTimestamp(caption.endMs)}\n${text}\n`;
		})
		.join("\n");
	if (result.length > MAX_SRT_LENGTH)
		throw new Error("SRT 파일이 너무 큽니다. 500만 자 이하로 나눠 주세요.");
	return result;
}

/** Start is inclusive, end is exclusive, matching the video's timeline. */
export function activeCaptionText(captions: readonly WebCaption[], timeSeconds: number): string {
	if (!Number.isFinite(timeSeconds)) return "";
	// Remove floating-point noise at millisecond boundaries (e.g. 1.001 * 1000).
	const timeMs = Math.round(timeSeconds * 1_000_000) / 1_000;
	return captions
		.filter((caption) => timeMs >= caption.startMs && timeMs < caption.endMs)
		.map((caption) => caption.text)
		.join("\n");
}
