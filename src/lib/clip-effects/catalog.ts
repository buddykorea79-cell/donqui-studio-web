export const CLIP_EFFECTS = [
	{ id: "zoom-in", label: "줌 인", description: "천천히 가까워집니다" },
	{ id: "zoom-out", label: "줌 아웃", description: "천천히 멀어집니다" },
	{ id: "pan-left", label: "왼쪽 이동", description: "화면이 왼쪽으로 흐릅니다" },
	{ id: "pan-right", label: "오른쪽 이동", description: "화면이 오른쪽으로 흐릅니다" },
	{ id: "pan-up", label: "위로 이동", description: "화면이 위로 흐릅니다" },
	{ id: "pan-down", label: "아래로 이동", description: "화면이 아래로 흐릅니다" },
	{ id: "fade", label: "페이드", description: "부드럽게 나타나고 사라집니다" },
	{ id: "slide-left", label: "슬라이드", description: "오른쪽에서 부드럽게 들어옵니다" },
	{ id: "slide-up", label: "떠오르기", description: "아래에서 부드럽게 들어옵니다" },
	{ id: "tilt", label: "시네마틱 틸트", description: "살짝 회전하며 가까워집니다" },
] as const;

export type ClipEffectId = "none" | (typeof CLIP_EFFECTS)[number]["id"];
export type ClipEffectSelection = ClipEffectId | "random";

export function isClipEffectId(value: unknown): value is ClipEffectId {
	return value === "none" || CLIP_EFFECTS.some((effect) => effect.id === value);
}

/** Resolve at clip creation, then persist the returned ID. Playback never rerolls it. */
export function resolveClipEffect(selection: ClipEffectSelection, seed: string): ClipEffectId {
	if (selection !== "random") return selection;
	let hash = 2166136261;
	for (let index = 0; index < seed.length; index++) {
		hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
	}
	return CLIP_EFFECTS[(hash >>> 0) % CLIP_EFFECTS.length].id;
}

export const CLIP_EFFECT_FPS = 30;
export const CLIP_EFFECT_VERSION = 2;

/** A photo is shown still for as long as the clip lasts; a video plays from `startMs`. */
export type ClipSourceKind = "video" | "image";

/**
 * How a source whose shape differs from the frame's sits in it: `cover` fills the frame and
 * crops what spills over, `contain` shows all of it with bars. Absent means `contain`, what
 * every render made before the choice existed did.
 */
export type ClipFit = "cover" | "contain";

export function isClipFit(value: unknown): value is ClipFit {
	return value === "cover" || value === "contain";
}

export interface CreateClipEffectRequest {
	sourcePath: string;
	/** Absent means a video, as every request made before photos could take an effect. */
	sourceKind?: ClipSourceKind;
	startMs: number;
	endMs: number;
	effect: ClipEffectId;
	/** The frame rendered: the project's output frame, within the ceiling below. */
	width: number;
	height: number;
	fit?: ClipFit;
}

export interface CreateClipEffectResult {
	success: boolean;
	filePath?: string;
	durationMs?: number;
	width?: number;
	height?: number;
	error?: string;
}

export type ClipEffectProps = {
	sourceUrl: string;
	startMs: number;
	effect: ClipEffectId;
	sourceKind?: ClipSourceKind;
	fit?: ClipFit;
	/** The effect's own length, when it plays as one part of a longer composition. */
	durationInFrames?: number;
};

/** 4K landscape / portrait ceiling; preserve aspect ratio and H.264 even dimensions. */
export function clipEffectDimensions(width: number, height: number) {
	const ratio = Math.min(1, 3840 / Math.max(width, height), 2160 / Math.min(width, height));
	return {
		width: Math.max(2, Math.floor((width * ratio) / 2) * 2),
		height: Math.max(2, Math.floor((height * ratio) / 2) * 2),
	};
}
