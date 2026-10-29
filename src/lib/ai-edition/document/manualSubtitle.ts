import type { AxcutDocument } from "../schema";
import { addSubtitles, type SubtitleKind } from "./subtitles";

export interface ManualSubtitleInput {
	text: string;
	startSec: number;
	endSec: number;
	/** A caption unless said otherwise. */
	kind?: SubtitleKind;
}

/** User text is an authored overlay, independent of ASR regeneration. See `subtitles.ts`. */
export function addManualSubtitle(
	doc: AxcutDocument,
	input: ManualSubtitleInput,
	aspect?: number,
): AxcutDocument {
	return addSubtitles(doc, [input], aspect).document;
}
