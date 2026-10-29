/**
 * V.Clip — the contract between the renderer and the main process for splitting a source
 * video into usable segments. Ported from AutoVeo's "영상 클립" step: candidate windows are
 * scored from sampled frames (sharpness, brightness, motion) and, when a local Ollama vision
 * model is available, by the model's own judgement of each window.
 */

/** Segment character, as AutoVeo's vision prompt classifies it. */
export const VCLIP_CATEGORIES = [
	{ id: "landscape_reveal", label: "풍경 공개" },
	{ id: "action", label: "움직임" },
	{ id: "orbit", label: "선회" },
	{ id: "fly_through", label: "통과 비행" },
	{ id: "static_beauty", label: "정적인 장면" },
	{ id: "subject_focus", label: "피사체 중심" },
	{ id: "transition", label: "전환 장면" },
	{ id: "highlight", label: "하이라이트" },
	{ id: "general", label: "일반" },
] as const;

export type VClipCategory = (typeof VCLIP_CATEGORIES)[number]["id"];

export const VCLIP_CATEGORY_IDS = VCLIP_CATEGORIES.map((category) => category.id) as [
	VClipCategory,
	...VClipCategory[],
];

export function vclipCategoryLabel(category: VClipCategory): string {
	return VCLIP_CATEGORIES.find((item) => item.id === category)?.label ?? "일반";
}

/** Segment length bounds (seconds), AutoVeo's VIDEO_SEGMENT_LIMITS. */
export const VCLIP_SEGMENT_LIMITS = {
	defaultSec: 5,
	minSec: 2,
	maxSec: 20,
	/** Windows analysed per source; bounds the number of vision calls. */
	maxCandidates: 12,
	/** Segments kept after overlap removal. */
	maxKeep: 12,
	/** Best segments pre-selected for clip creation. */
	preselect: 3,
} as const;

export interface VClipVisionModel {
	name: string;
	/** Bytes on disk, from Ollama's /api/tags. */
	size: number;
	parameterSize: string | null;
}

export interface VClipModelList {
	available: boolean;
	baseUrl: string;
	error: string | null;
	/** Vision-capable models only; text-only models cannot look at frames. */
	models: VClipVisionModel[];
}

export interface VClipProbeResult {
	success: boolean;
	durationSec?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	error?: string;
}

export interface VClipQuality {
	brightness: number;
	motion: number;
	sharpness: number;
	stability: number;
}

export interface VClipAiProposal {
	score: number;
	category: VClipCategory;
	description: string;
	caption: string;
	tags: string[];
}

export interface VClipWindowRequest {
	/** Groups the windows of one analysis run so it can be cancelled as a whole. */
	jobId: string;
	sourcePath: string;
	startSec: number;
	endSec: number;
	/** Ollama model name, or null to score from frame quality alone. */
	model: string | null;
	/** Shown to the model as context; usually the source file name. */
	title: string;
}

export interface VClipWindowAnalysis {
	startSec: number;
	endSec: number;
	/** 0–100: the model's score when it answered, else the frame-quality heuristic. */
	score: number;
	/**
	 * The frame-quality heuristic (55–95) on its own. Breaks ties between windows the model
	 * scored alike — a small model gives most of a drone flight the same number.
	 */
	qualityScore: number;
	/** One line for the card: the model's description, or the quality notes. */
	reason: string;
	quality: VClipQuality;
	ai: VClipAiProposal | null;
	/** Why the model's answer is missing although a model was requested. */
	aiError: string | null;
	/** Small JPEG data URL of the window's middle frame. */
	thumbnail: string | null;
}

export interface VClipWindowResult {
	success: boolean;
	result?: VClipWindowAnalysis;
	canceled?: boolean;
	error?: string;
}
