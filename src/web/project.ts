import { z } from "zod";
import {
	CLIP_EFFECT_FPS,
	type ClipEffectId,
	type ClipFit,
	isClipEffectId,
} from "../lib/clip-effects/catalog";
import type { WebCaption, WebCaptionStyle } from "./captions";
import {
	clipOutputToSourceTime,
	getClipOutputDuration,
	normalizeClipRegions,
	type WebSpeedRegion,
	type WebZoomRegion,
} from "./timelineEffects";

export type WebAsset = {
	id: string;
	name: string;
	kind: "video" | "image" | "audio";
	blob: Blob;
	duration: number;
	width?: number;
	height?: number;
};

export type WebClip = {
	id: string;
	assetId: string;
	trimStart: number;
	duration: number;
	volume: number;
	effect: ClipEffectId;
	fit?: ClipFit;
	caption: string;
	zoomRegions?: WebZoomRegion[];
	speedRegions?: WebSpeedRegion[];
};

export type WebAudio = {
	id: string;
	assetId: string;
	start: number;
	trimStart: number;
	duration: number;
	volume: number;
};

export type WebProject = {
	id: string;
	title: string;
	width: number;
	height: number;
	clips: WebClip[];
	audio: WebAudio[];
	captions?: WebCaption[];
	captionStyle?: WebCaptionStyle;
	updatedAt: string;
};

export type WebWorkspace = {
	project: WebProject;
	assets: WebAsset[];
};

const seconds = z.number().finite().min(0).max(86_400);
const identifier = z.string().min(1).max(256);
const volume = z.number().finite().min(0).max(2);
const dimension = z.number().int().min(1).max(32_768);
const clipSchema = z.object({
	id: identifier,
	assetId: identifier,
	trimStart: seconds,
	duration: seconds.positive(),
	volume,
	effect: z.custom<ClipEffectId>(isClipEffectId),
	fit: z.enum(["contain", "cover"]).optional(),
	caption: z.string().max(5_000),
	zoomRegions: z
		.array(
			z.object({
				id: identifier,
				start: seconds,
				end: seconds.positive(),
				scale: z.number().finite().min(1).max(5),
				focusX: z.number().finite().min(0).max(1),
				focusY: z.number().finite().min(0).max(1),
				easeInDuration: z.number().finite().positive().max(0.25).optional(),
				easeOutDuration: z.number().finite().positive().max(0.25).optional(),
				easeInOffset: z.number().finite().min(0).max(345_600).optional(),
				easeOutOffset: z.number().finite().min(0).max(345_600).optional(),
			}),
		)
		.max(10_000)
		.optional(),
	speedRegions: z
		.array(
			z.object({
				id: identifier,
				start: seconds,
				end: seconds.positive(),
				rate: z.number().finite().min(0.25).max(4),
			}),
		)
		.max(10_000)
		.optional(),
});
const workspaceSchema = z.object({
	project: z.object({
		id: identifier,
		title: z.string().min(1).max(500),
		width: z.number().int().min(2).max(7_680),
		height: z.number().int().min(2).max(7_680),
		clips: z.array(clipSchema).max(10_000),
		audio: z
			.array(
				z.object({
					id: identifier,
					assetId: identifier,
					start: seconds,
					trimStart: seconds,
					duration: seconds.positive(),
					volume,
				}),
			)
			.max(10_000),
		updatedAt: z.iso.datetime(),
		captions: z
			.array(
				z
					.object({
						id: identifier,
						text: z.string().max(5_000),
						startMs: z.number().int().min(0).max(86_400_000),
						endMs: z.number().int().min(1).max(86_400_000),
						timestampMs: z.number().finite().min(0).max(86_400_000).nullable(),
						confidence: z.number().finite().min(0).max(1).nullable(),
					})
					.refine((cue) => cue.endMs > cue.startMs),
			)
			.max(10_000)
			.optional(),
		captionStyle: z
			.object({
				fontSize: z.number().finite().min(0.02).max(0.1),
				color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
				position: z.enum(["top", "center", "bottom"]),
				background: z.boolean(),
			})
			.optional(),
	}),
	assets: z
		.array(
			z.object({
				id: identifier,
				name: z.string().min(1).max(1_000),
				kind: z.enum(["video", "image", "audio"]),
				blob: z.instanceof(Blob),
				duration: seconds,
				width: dimension.optional(),
				height: dimension.optional(),
			}),
		)
		.max(10_000),
});

/** Validate persisted data as well as its media references before using it. */
export function validateWorkspace(value: unknown): WebWorkspace {
	const result = workspaceSchema.safeParse(value);
	if (!result.success) {
		throw new Error("프로젝트 데이터 형식이 올바르지 않습니다.");
	}
	const workspace = result.data;
	const assets = new Map(workspace.assets.map((asset) => [asset.id, asset]));
	if (assets.size !== workspace.assets.length) {
		throw new Error("프로젝트에 중복된 미디어 ID가 있습니다.");
	}
	const ids = new Set<string>();
	for (const caption of workspace.project.captions ?? []) {
		if (ids.has(caption.id)) throw new Error("프로젝트에 중복된 자막 ID가 있습니다.");
		ids.add(caption.id);
	}
	ids.clear();
	const regionIds = new Set<string>();
	for (const item of [...workspace.project.clips, ...workspace.project.audio]) {
		if (ids.has(item.id)) throw new Error("프로젝트에 중복된 클립 ID가 있습니다.");
		ids.add(item.id);
		const asset = assets.get(item.assetId);
		if (!asset) throw new Error("프로젝트의 원본 미디어를 찾을 수 없습니다.");
		const isVisual = "effect" in item;
		if ((isVisual && asset.kind === "audio") || (!isVisual && asset.kind !== "audio")) {
			throw new Error("클립과 원본 미디어의 종류가 일치하지 않습니다.");
		}
		if (asset.kind !== "image" && item.trimStart + item.duration > asset.duration + 0.01) {
			throw new Error("클립의 재생 구간이 원본 미디어 길이를 초과합니다.");
		}
		if ("effect" in item) {
			for (const regions of [item.zoomRegions ?? [], item.speedRegions ?? []]) {
				let previousEnd = 0;
				for (const region of [...regions].sort((a, b) => a.start - b.start)) {
					if (regionIds.has(region.id))
						throw new Error("프로젝트에 중복된 효과 구간 ID가 있습니다.");
					regionIds.add(region.id);
					if (
						region.end <= region.start ||
						region.end > item.duration + 1e-7 ||
						region.start < previousEnd - 1e-7
					) {
						throw new Error("효과 구간이 겹치거나 클립 길이를 초과합니다.");
					}
					previousEnd = region.end;
				}
			}
		}
	}
	return workspace;
}

export function createProject(): WebProject {
	return {
		id: crypto.randomUUID(),
		title: "나의 첫 영상",
		width: 1280,
		height: 720,
		clips: [],
		audio: [],
		updatedAt: new Date().toISOString(),
	};
}

export function createClip(asset: WebAsset): WebClip {
	if (asset.kind === "audio") throw new Error("오디오는 오디오 트랙에 추가해 주세요.");
	return {
		id: crypto.randomUUID(),
		assetId: asset.id,
		trimStart: 0,
		duration: asset.kind === "image" ? 5 : asset.duration,
		volume: 1,
		effect: "none",
		caption: "",
	};
}

export function createAudio(asset: WebAsset): WebAudio {
	if (asset.kind !== "audio") throw new Error("오디오 파일을 선택해 주세요.");
	return {
		id: crypto.randomUUID(),
		assetId: asset.id,
		start: 0,
		trimStart: 0,
		duration: asset.duration,
		volume: 1,
	};
}

/** Visual clips define the movie's duration; audio outside that range is trimmed. */
export function getProjectDuration(project: WebProject): number {
	return project.clips.reduce((duration, clip) => duration + getClipOutputDuration(clip), 0);
}

export function getProjectFrameCount(project: WebProject): number {
	const duration = getProjectDuration(project);
	return duration > 0 ? Math.max(1, Math.ceil(duration * CLIP_EFFECT_FPS - 1e-7)) : 0;
}

/** Include both per-clip text and timed subtitles when saving a standalone SRT. */
export function getProjectCaptions(project: WebProject): WebCaption[] {
	let start = 0;
	const captions = [...(project.captions ?? [])];
	for (const clip of project.clips) {
		const outputDuration = getClipOutputDuration(clip);
		if (clip.caption.trim())
			captions.push({
				id: `clip-${clip.id}`,
				text: clip.caption,
				startMs: Math.round(start * 1000),
				endMs: Math.max(Math.round(start * 1000) + 1, Math.round((start + outputDuration) * 1000)),
				timestampMs: null,
				confidence: null,
			});
		start += outputDuration;
	}
	return captions.filter((caption) => caption.text.trim()).sort((a, b) => a.startMs - b.startMs);
}

export function moveClip(project: WebProject, clipId: string, direction: -1 | 1): WebProject {
	const index = project.clips.findIndex((clip) => clip.id === clipId);
	const next = index + direction;
	if (index < 0 || next < 0 || next >= project.clips.length) return project;
	const clips = [...project.clips];
	[clips[index], clips[next]] = [clips[next], clips[index]];
	return { ...project, clips, updatedAt: new Date().toISOString() };
}

/** Redistribute clip lengths proportionally, never reading past a video's end. */
export function fitClipsToDuration(
	project: WebProject,
	assets: WebAsset[],
	targetSeconds: number,
): WebProject {
	if (!Number.isFinite(targetSeconds) || targetSeconds <= 0 || targetSeconds > 86_400) {
		throw new Error("맞출 영상 길이는 0초보다 길고 24시간 이하여야 합니다.");
	}
	if (!project.clips.length) throw new Error("먼저 영상이나 사진을 타임라인에 추가해 주세요.");
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const sourceLimits = project.clips.map((clip) => {
		const asset = byId.get(clip.assetId);
		if (!asset) throw new Error("클립의 원본 미디어를 찾을 수 없습니다.");
		if (asset.kind === "image") return 86_400;
		return Math.max(0, asset.duration - clip.trimStart);
	});
	const limits = project.clips.map((clip, index) =>
		getClipOutputDuration({ ...clip, duration: sourceLimits[index] }),
	);
	const weights = project.clips.map(getClipOutputDuration);
	if (limits.some((limit) => limit <= 0)) {
		throw new Error("재생할 수 있는 구간이 없는 클립이 있습니다.");
	}
	if (limits.reduce((sum, limit) => sum + limit, 0) < targetSeconds - 0.001) {
		throw new Error("원본 영상 길이가 부족합니다. 사진이나 영상을 더 추가해 주세요.");
	}
	const durations = project.clips.map(() => 0);
	let pending = project.clips.map((_, index) => index);
	let remaining = targetSeconds;
	while (pending.length) {
		const weight = pending.reduce((sum, index) => sum + weights[index], 0);
		const capped = pending.filter((index) => (remaining * weights[index]) / weight > limits[index]);
		if (!capped.length) {
			for (const index of pending) {
				durations[index] = (remaining * weights[index]) / weight;
			}
			break;
		}
		for (const index of capped) {
			durations[index] = limits[index];
			remaining -= limits[index];
		}
		pending = pending.filter((index) => !capped.includes(index));
	}
	return {
		...project,
		clips: project.clips.map((clip, index) =>
			normalizeClipRegions({
				...clip,
				duration: clipOutputToSourceTime(
					{ ...clip, duration: sourceLimits[index] },
					durations[index],
				),
			}),
		),
		updatedAt: new Date().toISOString(),
	};
}
