import { describe, expect, it } from "vitest";
import {
	createProject,
	getProjectDuration,
	validateWorkspace,
	type WebAsset,
	type WebClip,
} from "./project";
import {
	applyTimelineRegion,
	deleteTimelineRange,
	getTimelineClips,
	normalizeTimelineRange,
	resizeClipEdge,
} from "./timelineEditing";
import { getClipOutputDuration, getZoomTransform } from "./timelineEffects";

const video: WebAsset = {
	id: "video",
	name: "video.mp4",
	kind: "video",
	duration: 20,
	blob: new Blob(["video"]),
};
const image: WebAsset = {
	id: "image",
	name: "image.png",
	kind: "image",
	duration: 0,
	blob: new Blob(["image"]),
};
const clip: WebClip = {
	id: "clip",
	assetId: video.id,
	trimStart: 2,
	duration: 8,
	volume: 1,
	effect: "none",
	caption: "clip text",
	speedRegions: [{ id: "speed", start: 2, end: 6, rate: 2 }],
	zoomRegions: [{ id: "zoom", start: 0, end: 8, scale: 3, focusX: 0.8, focusY: 0.3 }],
};
const photo: WebClip = {
	...clip,
	id: "photo",
	assetId: image.id,
	trimStart: 0,
	duration: 5,
	speedRegions: undefined,
	zoomRegions: undefined,
};
const project = {
	...createProject(),
	clips: [clip, photo],
	captions: [
		{ id: "cue", startMs: 4000, endMs: 7000, text: "timed", timestampMs: null, confidence: null },
	],
};

describe("timeline range and positions", () => {
	it("lays out clips by speed-adjusted duration", () => {
		expect(getTimelineClips(project)).toEqual([
			{ clip, start: 0, end: 6 },
			{ clip: photo, start: 6, end: 11 },
		]);
		expect(getTimelineClips({ ...project, clips: [] })).toEqual([]);
	});
	it("sorts and clamps a drag range without accepting invalid or subframe selections", () => {
		expect(normalizeTimelineRange({ start: 14, end: -2 }, 11)).toEqual({ start: 0, end: 11 });
		expect(normalizeTimelineRange({ start: 4, end: 2 }, 11)).toEqual({ start: 2, end: 4 });
		expect(normalizeTimelineRange({ start: 0, end: 1 / 30 }, 11)).toEqual({
			start: 0,
			end: 1 / 30,
		});
		expect(normalizeTimelineRange({ start: 1, end: 1.01 }, 11)).toBeNull();
		expect(normalizeTimelineRange({ start: 1, end: 1 }, 11)).toBeNull();
		expect(normalizeTimelineRange({ start: Number.NaN, end: 3 }, 11)).toBeNull();
		expect(normalizeTimelineRange({ start: 0, end: 3 }, Number.POSITIVE_INFINITY)).toBeNull();
		expect(normalizeTimelineRange({ start: 0, end: 3 }, 0)).toBeNull();
		expect(normalizeTimelineRange({ start: 0, end: 0.01 }, 0.01)).toEqual({ start: 0, end: 0.01 });
	});
});

describe("delete visual timeline range", () => {
	it("removes an interior range using the source time implied by playback speed", () => {
		const result = deleteTimelineRange(project, { start: 1, end: 4.5 }, [video, image]);
		expect(result.clips).toHaveLength(3);
		expect(result.clips[0]).toMatchObject({ id: clip.id, trimStart: 2, duration: 1 });
		expect(result.clips[1]).toMatchObject({ trimStart: 8.5, duration: 1.5 });
		expect(result.clips[1].id).not.toBe(clip.id);
		expect(getProjectDuration(result)).toBeCloseTo(7.5);
		expect(result.clips[2]).toBe(photo);
		expect(result.audio).toBe(project.audio);
		expect(result.captions).toBe(project.captions);
		expect(
			validateWorkspace({ project: result, assets: [video, image] }).project.clips,
		).toHaveLength(3);
	});
	it("deletes across clip boundaries and keeps image trims at zero", () => {
		const result = deleteTimelineRange(project, { start: 5, end: 8 }, [video, image]);
		expect(result.clips).toHaveLength(2);
		expect(result.clips[0]).toMatchObject({ trimStart: 2, duration: 7 });
		expect(result.clips[1]).toMatchObject({ id: photo.id, trimStart: 0, duration: 3 });
		expect(getProjectDuration(result)).toBeCloseTo(8);
		expect(
			validateWorkspace({ project: result, assets: [video, image] }).project.clips,
		).toHaveLength(2);
	});
	it("retains the exact zoom phase on both sides of a cut through entry and exit ramps", () => {
		const result = deleteTimelineRange({ ...project, clips: [clip] }, { start: 0.1, end: 5.9 }, [
			video,
		]);
		expect(result.clips).toHaveLength(2);
		for (const t of [0, 0.01, 0.05, 0.09]) {
			expect(getZoomTransform(result.clips[0], t).scale).toBeCloseTo(
				getZoomTransform(clip, t).scale,
				9,
			);
			expect(getZoomTransform(result.clips[1], t).scale).toBeCloseTo(
				getZoomTransform(clip, 5.9 + t).scale,
				9,
			);
		}
		const ids = result.clips.flatMap((item) =>
			[...(item.zoomRegions ?? []), ...(item.speedRegions ?? [])].map((region) => region.id),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
	it("handles a full removal, no-op range, and a repeated cut without modifying input", () => {
		expect(deleteTimelineRange(project, { start: 0, end: 11 }, [video, image]).clips).toEqual([]);
		expect(deleteTimelineRange(project, { start: -2, end: -1 })).toBe(project);
		const once = deleteTimelineRange(project, { start: 2, end: 3 }, [video, image]);
		const twice = deleteTimelineRange(once, { start: 2, end: 3 }, [video, image]);
		expect(getProjectDuration(twice)).toBeCloseTo(9);
		expect(
			validateWorkspace({ project: twice, assets: [video, image] }).project.clips.length,
		).toBeGreaterThan(1);
		expect(clip.duration).toBe(8);
		expect(clip.speedRegions).toEqual([{ id: "speed", start: 2, end: 6, rate: 2 }]);
	});
});

describe("clip edge resize", () => {
	it("trims each edge on the output clock and preserves the remaining source span", () => {
		const left = resizeClipEdge(clip, video, "start", 3);
		expect(left).toMatchObject({ id: clip.id, trimStart: 6, duration: 4 });
		expect(getClipOutputDuration(left)).toBe(3);
		expect(left.speedRegions?.[0]).toMatchObject({ start: 0, end: 2, rate: 2 });
		const right = resizeClipEdge(clip, video, "end", -3);
		expect(right).toMatchObject({ id: clip.id, trimStart: 2, duration: 4 });
		expect(getClipOutputDuration(right)).toBe(3);
		expect(right.speedRegions?.[0]).toMatchObject({ start: 2, end: 4, rate: 2 });
	});
	it("preserves zoom ramp pictures when either edge cuts a transition", () => {
		const left = resizeClipEdge(clip, video, "start", 0.1);
		const right = resizeClipEdge(clip, video, "end", -0.1);
		for (const t of [0, 0.01, 0.05, 0.12])
			expect(getZoomTransform(left, t).scale).toBeCloseTo(getZoomTransform(clip, t + 0.1).scale, 9);
		for (const t of [5.7, 5.8, 5.85])
			expect(getZoomTransform(right, t).scale).toBeCloseTo(getZoomTransform(clip, t).scale, 9);
	});
	it("clamps to a one-frame remainder even at slow playback rates", () => {
		const slow = { ...clip, speedRegions: [{ id: "slow", start: 0, end: 8, rate: 0.25 }] };
		for (const [edge, delta] of [
			["start", 100],
			["end", -100],
		] as const) {
			const result = resizeClipEdge(slow, video, edge, delta);
			expect(getClipOutputDuration(result)).toBeCloseTo(1 / 30, 9);
			expect(result.duration).toBeCloseTo(1 / 120, 9);
			expect(result.trimStart + result.duration).toBeLessThanOrEqual(video.duration);
		}
	});
	it("extends source video only as far as available and leaves new source spans at 1×", () => {
		const left = resizeClipEdge(clip, video, "start", -50);
		expect(left).toMatchObject({ trimStart: 0, duration: 10 });
		expect(getClipOutputDuration(left)).toBe(8);
		expect(left.speedRegions?.[0]).toMatchObject({ start: 4, end: 8, rate: 2 });
		expect(getZoomTransform(left, 2.1).scale).toBeCloseTo(getZoomTransform(clip, 0.1).scale, 9);
		const right = resizeClipEdge(clip, video, "end", 50);
		expect(right).toMatchObject({ trimStart: 2, duration: 18 });
		expect(getClipOutputDuration(right)).toBe(16);
		expect(right.speedRegions).toBe(clip.speedRegions);
	});
	it("extends and shortens photos while bounding duration and preserving image trim semantics", () => {
		const photoWithZoom = {
			...photo,
			zoomRegions: [{ id: "photo-zoom", start: 1, end: 4, scale: 2, focusX: 0.5, focusY: 0.5 }],
		};
		const extended = resizeClipEdge(photoWithZoom, image, "start", -2);
		expect(extended).toMatchObject({ trimStart: 0, duration: 7 });
		expect(extended.zoomRegions?.[0]).toMatchObject({ start: 3, end: 6 });
		const shortened = resizeClipEdge(extended, image, "start", 4);
		expect(shortened).toMatchObject({ trimStart: 0, duration: 3 });
		expect(shortened.zoomRegions?.[0]).toMatchObject({ start: 0, end: 2 });
		expect(resizeClipEdge(photo, image, "end", 1e10).duration).toBe(86400);
	});
	it("ignores invalid/no-op deltas and rejects an unrelated source", () => {
		for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, 0])
			expect(resizeClipEdge(clip, video, "end", delta)).toBe(clip);
		expect(() => resizeClipEdge(clip, image, "end", 1)).toThrow();
		expect(resizeClipEdge({ ...clip, trimStart: 0 }, video, "start", -1)).toMatchObject({
			trimStart: 0,
			duration: 8,
		});
	});
});

describe("effects applied to a timeline selection", () => {
	it("adds speed to source-correct spans across video and photo clips", () => {
		const result = applyTimelineRegion(project, "speed", { start: 5, end: 8 });
		expect(result.project.clips[0].speedRegions?.at(-1)).toMatchObject({
			start: 7,
			end: 8,
			rate: 2,
		});
		expect(result.project.clips[1].speedRegions?.[0]).toMatchObject({ start: 0, end: 2, rate: 2 });
		expect(result.selection).toMatchObject({ clipId: clip.id, kind: "speed" });
		expect(getProjectDuration(result.project)).toBeCloseTo(9.5);
		expect(result.project.clips[0].zoomRegions).toBe(clip.zoomRegions);
		expect(result.project.captions).toBe(project.captions);
		expect(
			validateWorkspace({ project: result.project, assets: [video, image] }).project.clips,
		).toHaveLength(2);
	});
	it("replaces only the selected portion of an overlapping speed region", () => {
		const slow = { ...clip, speedRegions: [{ id: "slow", start: 0, end: 8, rate: 0.5 }] };
		const result = applyTimelineRegion({ ...project, clips: [slow] }, "speed", {
			start: 6,
			end: 10,
		});
		expect(
			result.project.clips[0].speedRegions?.map(({ start, end, rate }) => ({ start, end, rate })),
		).toEqual([
			{ start: 0, end: 3, rate: 0.5 },
			{ start: 3, end: 5, rate: 2 },
			{ start: 5, end: 8, rate: 0.5 },
		]);
		expect(getProjectDuration(result.project)).toBe(13);
		const ids = result.project.clips[0].speedRegions?.map((region) => region.id);
		expect(new Set(ids).size).toBe(3);
		expect(
			validateWorkspace({ project: result.project, assets: [video] }).project.clips,
		).toHaveLength(1);
	});
	it("preserves old zoom fragments and their exact entry/exit phases outside the new range", () => {
		const result = applyTimelineRegion({ ...project, clips: [clip] }, "zoom", {
			start: 0.1,
			end: 5.9,
		});
		const zoomed = result.project.clips[0];
		expect(zoomed.zoomRegions).toHaveLength(3);
		expect(zoomed.zoomRegions?.[1]).toMatchObject({ start: 0.1, end: 7.9, scale: 2 });
		for (const t of [0, 0.01, 0.05, 0.09, 5.9, 5.92, 5.95, 5.99])
			expect(getZoomTransform(zoomed, t).scale).toBeCloseTo(getZoomTransform(clip, t).scale, 9);
		expect(zoomed.speedRegions).toBe(clip.speedRegions);
		expect(
			validateWorkspace({ project: result.project, assets: [video] }).project.clips,
		).toHaveLength(1);
	});
	it("does not add effects for an invalid selection or change clips outside it", () => {
		expect(applyTimelineRegion(project, "zoom", { start: 2, end: 2 })).toEqual({
			project,
			selection: null,
		});
		const result = applyTimelineRegion(project, "zoom", { start: 7, end: 8 });
		expect(result.project.clips[0]).toBe(clip);
		expect(result.project.clips[1].zoomRegions?.[0]).toMatchObject({ start: 1, end: 2 });
	});
});
