import { describe, expect, it } from "vitest";
import {
	createAudio,
	createClip,
	createProject,
	fitClipsToDuration,
	getProjectDuration,
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
