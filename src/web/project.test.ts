import { describe, expect, it } from "vitest";
import { CLIP_EFFECTS } from "../lib/clip-effects/catalog";
import { DEFAULT_CAPTION_STYLE, type WebCaption } from "./captions";
import {
	createAudio,
	createClip,
	createProject,
	fitClipsToDuration,
	getProjectCaptions,
	getProjectDuration,
	getProjectFrameCount,
	moveClip,
	validateWorkspace,
	type WebAsset,
	type WebWorkspace,
} from "./project";

function asset(id: string, kind: WebAsset["kind"], duration = 10): WebAsset {
	return { id, name: `${id}.media`, kind, duration, blob: new Blob([id]) };
}

function workspace(): WebWorkspace {
	const assets = [asset("video", "video"), asset("photo", "image", 0), asset("music", "audio", 30)];
	return {
		assets,
		project: {
			...createProject(),
			clips: assets.slice(0, 2).map(createClip),
			audio: [createAudio(assets[2])],
		},
	};
}

describe("browser project validation", () => {
	it("accepts older projects without fit, timed captions or caption styles", () => {
		const current = workspace();
		const restored = validateWorkspace(current);
		expect(restored).toEqual(current);
		expect(restored.project.clips[0].fit).toBeUndefined();
		expect(restored.project.captions).toBeUndefined();
		expect(restored.project.captionStyle).toBeUndefined();
		expect(restored.project.clips[0].zoomRegions).toBeUndefined();
		expect(restored.project.clips[0].speedRegions).toBeUndefined();
	});

	it("validates region bounds, same-type overlap, duplicate IDs and numeric settings", () => {
		const current = workspace();
		const zoom = { id: "zoom", start: 1, end: 4, scale: 2, focusX: 0.5, focusY: 0.5 };
		const speed = { id: "speed", start: 1, end: 4, rate: 2 };
		const visual = { ...current.project.clips[0], zoomRegions: [zoom], speedRegions: [speed] };
		const validate = (change: Record<string, unknown>) =>
			validateWorkspace({
				...current,
				project: { ...current.project, clips: [{ ...visual, ...change }] },
			});
		expect(validate({}).project.clips[0]).toEqual(visual);
		for (const change of [
			{ start: -1 },
			{ scale: 6 },
			{ focusX: 1.1 },
			{ focusY: Number.NaN },
			{ easeInDuration: 0 },
			{ easeOutDuration: 0.3 },
			{ easeInOffset: -1 },
			{ easeOutOffset: Number.POSITIVE_INFINITY },
		]) {
			expect(() => validate({ zoomRegions: [{ ...zoom, ...change }] })).toThrow("데이터 형식");
		}
		for (const rate of [0, 0.1, 4.1, Number.POSITIVE_INFINITY]) {
			expect(() => validate({ speedRegions: [{ ...speed, rate }] })).toThrow("데이터 형식");
		}
		for (const change of [{ end: 11 }, { start: 4 }, { start: 5 }]) {
			expect(() => validate({ speedRegions: [{ ...speed, ...change }] })).toThrow("효과 구간");
		}
		expect(() =>
			validate({ zoomRegions: [zoom, { ...zoom, id: "overlap", start: 3, end: 5 }] }),
		).toThrow("효과 구간");
		expect(() => validate({ speedRegions: [speed, { ...speed, start: 5, end: 7 }] })).toThrow(
			"중복된 효과 구간",
		);
		expect(() => validate({ speedRegions: [{ ...speed, id: "zoom" }] })).toThrow(
			"중복된 효과 구간",
		);
		expect(
			validate({ speedRegions: [speed, { ...speed, id: "touching", start: 4, end: 5 }] }),
		).toBeTruthy();
	});

	it("uses output time for total duration and clip captions while preserving timed cues", () => {
		const current = workspace();
		current.project.clips[0] = {
			...current.project.clips[0],
			caption: "빠른 영상",
			speedRegions: [{ id: "fast", start: 0, end: 10, rate: 2 }],
		};
		current.project.clips[1].caption = "사진";
		const timed = {
			id: "timed",
			text: "시간 자막",
			startMs: 6000,
			endMs: 7000,
			timestampMs: null,
			confidence: null,
		};
		current.project.captions = [timed];
		expect(getProjectDuration(current.project)).toBe(10);
		expect(getProjectFrameCount(current.project)).toBe(300);
		expect(getProjectCaptions(current.project)).toMatchObject([
			{ text: "빠른 영상", startMs: 0, endMs: 5000 },
			{ text: "사진", startMs: 5000, endMs: 10000 },
			timed,
		]);
	});

	it("accepts all shared Remotion effects and either media fitting mode", () => {
		const current = workspace();
		for (const { id } of CLIP_EFFECTS) {
			for (const fit of ["contain", "cover"] as const) {
				current.project.clips[0] = { ...current.project.clips[0], effect: id, fit };
				expect(validateWorkspace(current).project.clips[0]).toMatchObject({ effect: id, fit });
			}
		}
	});

	it("rejects unknown effects and fit values in persisted project data", () => {
		const current = workspace();
		for (const invalid of [{ effect: "spin" }, { fit: "stretch" }]) {
			expect(() =>
				validateWorkspace({
					...current,
					project: { ...current.project, clips: [{ ...current.project.clips[0], ...invalid }] },
				}),
			).toThrow("데이터 형식");
		}
	});

	it("rejects invalid caption timings, duplicate cue IDs and malformed styles", () => {
		const current = workspace();
		const caption: WebCaption = {
			id: "caption",
			text: "자막",
			startMs: 1000,
			endMs: 2000,
			timestampMs: null,
			confidence: null,
		};
		for (const change of [
			{ startMs: -1 },
			{ startMs: 2000 },
			{ startMs: 1000.5 },
			{ endMs: Number.NaN },
			{ endMs: 86_400_001 },
		]) {
			expect(() =>
				validateWorkspace({
					...current,
					project: { ...current.project, captions: [{ ...caption, ...change }] },
				}),
			).toThrow("데이터 형식");
		}
		expect(() =>
			validateWorkspace({
				...current,
				project: { ...current.project, captions: [caption, caption] },
			}),
		).toThrow("중복된 자막");
		for (const change of [
			{ color: "red" },
			{ color: "#abcd" },
			{ fontSize: 0 },
			{ fontSize: 0.11 },
			{ position: "outside" },
		]) {
			expect(() =>
				validateWorkspace({
					...current,
					project: { ...current.project, captionStyle: { ...DEFAULT_CAPTION_STYLE, ...change } },
				}),
			).toThrow("데이터 형식");
		}
	});

	it("preserves media blobs and keeps audio from extending the visual timeline", () => {
		const current = workspace();
		const valid = validateWorkspace(current);
		expect(valid.assets[0].blob).toBe(current.assets[0].blob);
		expect(getProjectDuration(valid.project)).toBe(15);
	});

	it("rejects missing media and duplicate identifiers", () => {
		const current = workspace();
		expect(() => validateWorkspace({ ...current, assets: [] })).toThrow("원본 미디어");
		expect(() =>
			validateWorkspace({ ...current, assets: [...current.assets, current.assets[0]] }),
		).toThrow("중복된 미디어");
		current.project.clips[1].id = current.project.clips[0].id;
		expect(() => validateWorkspace(current)).toThrow("중복된 클립");
	});

	it("rejects invalid values and trims outside the source", () => {
		const current = workspace();
		current.project.clips[0].trimStart = 2;
		expect(() => validateWorkspace(current)).toThrow("원본 미디어 길이");
		current.project.clips[0].duration = Number.NaN;
		expect(() => validateWorkspace(current)).toThrow("데이터 형식");
	});

	it("rejects audio used as a visual clip", () => {
		const current = workspace();
		current.project.clips[0].assetId = "music";
		expect(() => validateWorkspace(current)).toThrow("종류");
	});

	it("reorders existing clips without changing the original project", () => {
		const { project } = workspace();
		const firstId = project.clips[0].id;
		expect(moveClip(project, firstId, 1).clips[1].id).toBe(firstId);
		expect(project.clips[0].id).toBe(firstId);
		expect(moveClip(project, firstId, -1)).toBe(project);
		expect(moveClip(project, "missing", 1)).toBe(project);
	});
});

describe("fitting visuals to music", () => {
	it("fits output durations and clips speed/zoom ranges when shortening", () => {
		const current = workspace();
		current.project.clips[0] = {
			...current.project.clips[0],
			speedRegions: [{ id: "fast", start: 0, end: 10, rate: 2 }],
			zoomRegions: [{ id: "zoom", start: 1, end: 8, scale: 2, focusX: 0.5, focusY: 0.5 }],
		};
		const fitted = fitClipsToDuration(current.project, current.assets, 4);
		expect(fitted.clips.map((clip) => clip.duration)).toEqual([4, 2]);
		expect(fitted.clips[0].speedRegions?.[0].end).toBe(4);
		expect(fitted.clips[0].zoomRegions?.[0].end).toBe(4);
		expect(getProjectDuration(fitted)).toBe(4);
		expect(validateWorkspace({ ...current, project: fitted })).toBeTruthy();
		const longer = fitClipsToDuration(current.project, current.assets, 20);
		expect(longer.clips.map((clip) => clip.duration)).toEqual([10, 15]);
		expect(getProjectDuration(longer)).toBe(20);
	});

	it("extends new source tails at normal speed without lengthening an existing speed region", () => {
		const current = workspace();
		current.project.clips = [
			{
				...current.project.clips[0],
				duration: 4,
				speedRegions: [{ id: "fast", start: 0, end: 4, rate: 2 }],
			},
		];
		const longer = fitClipsToDuration(current.project, current.assets, 6);
		expect(longer.clips[0].duration).toBe(8);
		expect(longer.clips[0].speedRegions?.[0].end).toBe(4);
		expect(getProjectDuration(longer)).toBe(6);
		expect(() => fitClipsToDuration(current.project, current.assets, 9)).toThrow("길이가 부족");
	});
	it("extends photos when video reaches its source duration", () => {
		const current = workspace();
		const fitted = fitClipsToDuration(current.project, current.assets, 30);
		expect(fitted.clips.map((clip) => clip.duration)).toEqual([10, 20]);
		expect(getProjectDuration(fitted)).toBe(30);
		expect(validateWorkspace({ ...current, project: fitted })).toBeTruthy();
	});

	it("shortens all clips proportionally and respects a trimmed video's end", () => {
		const current = workspace();
		current.project.clips[0].trimStart = 5;
		current.project.clips[0].duration = 5;
		const shortened = fitClipsToDuration(current.project, current.assets, 4);
		expect(shortened.clips.map((clip) => clip.duration)).toEqual([2, 2]);
		const extended = fitClipsToDuration(current.project, current.assets, 12);
		expect(extended.clips.map((clip) => clip.duration)).toEqual([5, 7]);
	});

	it("reports insufficient footage instead of manufacturing repeated video", () => {
		const current = workspace();
		current.project.clips = [current.project.clips[0]];
		expect(() => fitClipsToDuration(current.project, current.assets, 30)).toThrow("길이가 부족");
		expect(() => fitClipsToDuration(current.project, current.assets, 0)).toThrow("0초보다");
	});
});

describe("output frame grid", () => {
	it("does not add a phantom final frame when fractional clip lengths accumulate", () => {
		const current = workspace();
		current.project.clips = current.project.clips.map((clip, index) => ({
			...clip,
			duration: index === 0 ? 0.1 : 0.2,
		}));
		expect(getProjectDuration(current.project)).toBeGreaterThan(0.3);
		expect(getProjectFrameCount(current.project)).toBe(9);
		expect((getProjectFrameCount(current.project) - 1) / 30).toBe(8 / 30);
	});

	it("keeps a genuine partial final frame and returns no frames for an empty timeline", () => {
		const current = workspace();
		current.project.clips = [{ ...current.project.clips[0], duration: 0.301 }];
		expect(getProjectFrameCount(current.project)).toBe(10);
		expect(getProjectFrameCount(createProject())).toBe(0);
	});
});
