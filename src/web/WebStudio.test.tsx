// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIP_EFFECTS } from "../lib/clip-effects/catalog";
import { parseSrt } from "./captions";
import { exportVideo } from "./exportVideo";
import { downloadBlob, importMedia } from "./media";
import {
	createAudio,
	createClip,
	createProject,
	getProjectDuration,
	type WebAsset,
	type WebWorkspace,
} from "./project";
import { loadWorkspace, saveWorkspace } from "./storage";
import { WebStudio } from "./WebStudio";
import { WEB_NOTICE_SEEN_KEY } from "./WebVersionNotice";

vi.mock("./storage", () => ({
	loadWorkspace: vi.fn(),
	saveWorkspace: vi.fn(),
	clearWorkspace: vi.fn(),
}));
vi.mock("./media", async (importOriginal) => {
	const original = await importOriginal<typeof import("./media")>();
	return { ...original, importMedia: vi.fn(), downloadBlob: vi.fn() };
});
vi.mock("./Preview", () => ({ Preview: () => <div aria-label="미리보기 화면" /> }));
vi.mock("./useScreenRecording", () => ({
	useScreenRecording: () => ({
		supported: false,
		recording: false,
		starting: false,
		start: vi.fn(),
		stop: vi.fn(),
	}),
}));
vi.mock("./exportVideo", () => ({ exportVideo: vi.fn() }));

function photo(): WebAsset {
	return {
		id: "photo-1",
		name: "trip.jpg",
		kind: "image",
		blob: new Blob(["photo"], { type: "image/jpeg" }),
		duration: 5,
		width: 1280,
		height: 720,
	};
}

function savedWorkspace(): WebWorkspace {
	const image = photo();
	return {
		project: { ...createProject(), title: "불러온 여행 영상", clips: [createClip(image)] },
		assets: [image],
	};
}

async function renderReady() {
	const view = render(<WebStudio />);
	await act(async () => Promise.resolve());
	return view;
}

async function finishSave() {
	await act(async () => vi.advanceTimersByTimeAsync(650));
}

function selectRange(start: number, end: number) {
	fireEvent.change(screen.getByRole("spinbutton", { name: "선택 시작 (초)" }), {
		target: { value: String(start) },
	});
	fireEvent.change(screen.getByRole("spinbutton", { name: "선택 끝 (초)" }), {
		target: { value: String(end) },
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	localStorage.setItem(WEB_NOTICE_SEEN_KEY, "true");
	// jsdom does not implement the native dialog methods or focus trapping.
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value: function (this: HTMLDialogElement) {
			this.open = true;
		},
	});
	Object.defineProperty(HTMLDialogElement.prototype, "close", {
		configurable: true,
		value: function (this: HTMLDialogElement) {
			this.open = false;
		},
	});
	vi.mocked(loadWorkspace).mockResolvedValue(null);
	vi.mocked(saveWorkspace).mockResolvedValue(undefined);
	vi.mocked(importMedia).mockResolvedValue(photo());
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn(() => "blob:media-test");
			static revokeObjectURL = vi.fn();
		},
	);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
	Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
	Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("web version notice", () => {
	it("explains web restrictions on first visit and remembers dismissal", async () => {
		localStorage.removeItem(WEB_NOTICE_SEEN_KEY);
		const view = await renderReady();
		expect(screen.getByRole("dialog", { name: "웹 버전 안내" })).toBeVisible();
		expect(screen.getByText("AI 장면 분석·음성 인식 자동 자막 미지원")).toBeVisible();
		const link = screen.getByRole("link", { name: "로컬 버전 받기" });
		expect(link).toHaveAttribute("href", "https://github.com/buddykorea79-cell/Donqui-Studio.git");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		fireEvent.click(screen.getByRole("button", { name: "웹에서 계속하기" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(localStorage.getItem(WEB_NOTICE_SEEN_KEY)).toBe("true");
		view.unmount();
		await renderReady();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("reopens from help and handles Escape through the native cancel event", async () => {
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: "도움말" }));
		const dialog = screen.getByRole("dialog", { name: "웹 버전 안내" });
		fireEvent(dialog, new Event("cancel", { cancelable: true }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("can still dismiss when browser preferences cannot be read or saved", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		await renderReady();
		expect(screen.getByRole("dialog", { name: "웹 버전 안내" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "안내 닫기" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

describe("web editor project lifecycle", () => {
	it("waits for hydration before autosaving and never replaces the saved project with an empty one", async () => {
		let restore: (workspace: WebWorkspace) => void = () => undefined;
		vi.mocked(loadWorkspace).mockReturnValue(
			new Promise((resolve) => {
				restore = resolve;
			}),
		);
		render(<WebStudio />);
		await finishSave();
		expect(saveWorkspace).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "프로젝트 이름" })).not.toBeInTheDocument();
		const original = savedWorkspace();
		await act(async () => restore(original));
		expect(screen.getByRole("textbox", { name: "프로젝트 이름" })).toHaveValue(
			original.project.title,
		);
		await finishSave();
		expect(saveWorkspace).toHaveBeenCalledExactlyOnceWith(original);
	});

	it("keeps corrupted or inaccessible storage untouched until the user chooses recovery", async () => {
		vi.mocked(loadWorkspace).mockRejectedValue(new Error("복구할 수 없는 프로젝트입니다."));
		await renderReady();
		await finishSave();
		expect(screen.getByRole("heading", { name: "저장된 작업을 열 수 없습니다" })).toBeVisible();
		expect(screen.getByText("복구할 수 없는 프로젝트입니다.")).toBeVisible();
		expect(saveWorkspace).not.toHaveBeenCalled();
	});

	it("imports media, edits captions, undoes/redoes changes, and restores a deleted clip", async () => {
		const view = await renderReady();
		const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
		expect(input).not.toBeNull();
		await act(async () => {
			fireEvent.change(input!, {
				target: { files: [new File(["photo"], "trip.jpg", { type: "image/jpeg" })] },
			});
		});
		expect(importMedia).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.jpg/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "자막" }), {
			target: { value: "가을의 첫 장면" },
		});
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].project.clips[0].caption).toBe(
			"가을의 첫 장면",
		);
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.getByRole("textbox", { name: "자막" })).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
		expect(screen.getByRole("textbox", { name: "자막" })).toHaveValue("가을의 첫 장면");
		fireEvent.click(screen.getByRole("button", { name: "클립 삭제" }));
		expect(screen.queryByRole("button", { name: /01.*trip.jpg/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.getByRole("button", { name: /01.*trip.jpg/ })).toBeVisible();
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].project.clips).toHaveLength(1);
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].assets[0].blob).toBeInstanceOf(Blob);
	});

	it("surfaces quota failures instead of displaying a successful save", async () => {
		vi.mocked(saveWorkspace).mockRejectedValue(new Error("저장 공간이 부족합니다."));
		await renderReady();
		await finishSave();
		expect(screen.getByText("저장 실패 · 백업 필요")).toBeVisible();
		expect(screen.getByText("저장 공간이 부족합니다.")).toBeVisible();
		expect(screen.queryByText("이 브라우저에 저장됨")).not.toBeInTheDocument();
	});

	it("splits trimmed footage at the playhead without duplicating its source range", async () => {
		const original = savedWorkspace();
		original.assets[0] = { ...original.assets[0], kind: "video", name: "trip.mp4", duration: 12 };
		original.project.clips[0] = {
			...original.project.clips[0],
			trimStart: 1,
			duration: 8,
			volume: 0.35,
			effect: "pan-left",
			fit: "cover",
			caption: "여행 기록",
		};
		original.project.captions = [
			{
				id: "timed",
				text: "시간 자막",
				startMs: 3500,
				endMs: 4500,
				timestampMs: null,
				confidence: null,
			},
		];
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.mp4/ }));
		fireEvent.change(screen.getByRole("slider", { name: "재생 위치" }), { target: { value: "4" } });
		fireEvent.click(screen.getByRole("button", { name: "나누기" }));
		await finishSave();
		const clips = vi.mocked(saveWorkspace).mock.lastCall?.[0].project.clips;
		expect(clips).toHaveLength(2);
		expect(clips?.map(({ trimStart, duration }) => ({ trimStart, duration }))).toEqual([
			{ trimStart: 1, duration: 4 },
			{ trimStart: 5, duration: 4 },
		]);
		expect(clips?.[1].id).not.toBe(clips?.[0].id);
		for (const clip of clips ?? [])
			expect(clip).toMatchObject({
				caption: "여행 기록",
				volume: 0.35,
				effect: "pan-left",
				fit: "cover",
			});
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].project.captions).toEqual(
			original.project.captions,
		);
	});

	it("serializes pending saves so an older write cannot replace a later edit", async () => {
		let finishFirst: () => void = () => undefined;
		vi.mocked(loadWorkspace).mockResolvedValue(savedWorkspace());
		vi.mocked(saveWorkspace).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve;
				}),
		);
		await renderReady();
		await finishSave();
		expect(saveWorkspace).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByRole("textbox", { name: "프로젝트 이름" }), {
			target: { value: "최신 프로젝트 이름" },
		});
		await finishSave();
		expect(saveWorkspace).toHaveBeenCalledTimes(1);
		await act(async () => finishFirst());
		expect(saveWorkspace).toHaveBeenCalledTimes(2);
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].project.title).toBe("최신 프로젝트 이름");
		expect(screen.getByText("이 브라우저에 저장됨")).toBeVisible();
	});

	it("cancels an in-flight export without downloading a partial movie", async () => {
		vi.mocked(loadWorkspace).mockResolvedValue(savedWorkspace());
		vi.mocked(exportVideo).mockImplementation(
			(_project, _assets, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(new DOMException("취소", "AbortError")),
					);
				}),
		);
		await renderReady();
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "영상 내보내기" })));
		expect(screen.getByRole("dialog", { name: "영상을 만들고 있어요" })).toBeVisible();
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "내보내기 취소" })));
		expect(vi.mocked(exportVideo).mock.lastCall?.[2]?.signal?.aborted).toBe(true);
		expect(downloadBlob).not.toHaveBeenCalled();
		expect(screen.getByText("영상 내보내기를 취소했습니다.")).toBeVisible();
		expect(screen.queryByRole("dialog", { name: "영상을 만들고 있어요" })).not.toBeInTheDocument();
	});
});

describe("effects and subtitles in the editor", () => {
	it("undoes and redoes effect and fitting edits before passing the current project to export", async () => {
		const original = savedWorkspace();
		original.assets[0] = { ...original.assets[0], kind: "video", name: "trip.mp4", duration: 12 };
		original.project.clips[0] = {
			...original.project.clips[0],
			trimStart: 2,
			duration: 6,
			volume: 0.4,
			caption: "원래 자막",
		};
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		const result = { blob: new Blob(["movie"], { type: "video/mp4" }), extension: "mp4" as const };
		vi.mocked(exportVideo).mockResolvedValue(result);
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.mp4/ }));
		fireEvent.change(screen.getByRole("combobox", { name: "Remotion 효과" }), {
			target: { value: "tilt" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "화면 맞춤" }), {
			target: { value: "cover" },
		});
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.getByRole("combobox", { name: "화면 맞춤" })).toHaveValue("contain");
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.getByRole("combobox", { name: "Remotion 효과" })).toHaveValue("none");
		fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
		fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
		expect(screen.getByRole("combobox", { name: "Remotion 효과" })).toHaveValue("tilt");
		expect(screen.getByRole("combobox", { name: "화면 맞춤" })).toHaveValue("cover");
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "영상 내보내기" })));
		expect(exportVideo).toHaveBeenCalledOnce();
		const [project, assets, options] = vi.mocked(exportVideo).mock.calls[0];
		expect(project.clips[0]).toEqual({
			...original.project.clips[0],
			effect: "tilt",
			fit: "cover",
		});
		expect(assets).toEqual(original.assets);
		expect(options?.signal?.aborted).toBe(false);
		expect(options?.onProgress).toBeTypeOf("function");
		expect(downloadBlob).toHaveBeenCalledWith(result.blob, `${original.project.title}.mp4`);
	});

	it("resolves bulk random effects once and keeps them after rerender and project reload", async () => {
		const original = savedWorkspace();
		original.project.clips = Array.from({ length: 4 }, () => createClip(original.assets[0]));
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		const view = await renderReady();
		fireEvent.click(screen.getByRole("button", { name: "클립마다 무작위 효과" }));
		await finishSave();
		const saved = vi.mocked(saveWorkspace).mock.lastCall?.[0];
		expect(saved).toBeDefined();
		const choices = new Set<string>(CLIP_EFFECTS.map((effect) => effect.id));
		const resolved = saved!.project.clips.map((clip) => clip.effect);
		expect(resolved).toHaveLength(4);
		expect(resolved.every((effect) => choices.has(effect))).toBe(true);
		fireEvent.change(screen.getByRole("textbox", { name: "프로젝트 이름" }), {
			target: { value: "이름만 변경" },
		});
		view.rerender(<WebStudio />);
		await finishSave();
		expect(
			vi.mocked(saveWorkspace).mock.lastCall?.[0].project.clips.map((clip) => clip.effect),
		).toEqual(resolved);
		view.unmount();
		vi.mocked(loadWorkspace).mockResolvedValue(saved!);
		await renderReady();
		await finishSave();
		expect(
			vi.mocked(saveWorkspace).mock.lastCall?.[0].project.clips.map((clip) => clip.effect),
		).toEqual(resolved);
	});

	it("sends edited timed subtitles to video export and includes both caption kinds in SRT", async () => {
		// jsdom's Blob lacks text(); use Node's browser-compatible Blob to inspect the download.
		vi.stubGlobal("Blob", NodeBlob);
		const original = savedWorkspace();
		original.project.clips[0].caption = "클립 전체 자막";
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		vi.mocked(exportVideo).mockResolvedValue({ blob: new Blob(["movie"]), extension: "mp4" });
		await renderReady();
		fireEvent.change(screen.getByRole("slider", { name: "재생 위치" }), { target: { value: "1" } });
		fireEvent.click(screen.getByRole("button", { name: "현재 위치에 자막 추가" }));
		fireEvent.change(screen.getByRole("textbox", { name: "시간 자막 내용" }), {
			target: { value: "필요한 순간에 표시" },
		});
		fireEvent.change(screen.getByLabelText("자막 끝 (초)"), { target: { value: "2.5" } });
		fireEvent.change(screen.getByLabelText("자막 위치"), { target: { value: "top" } });
		fireEvent.click(screen.getByRole("button", { name: "SRT 저장" }));
		const srtDownload = vi.mocked(downloadBlob).mock.lastCall;
		expect(srtDownload?.[1]).toBe(`${original.project.title}.srt`);
		const cues = parseSrt(await srtDownload![0].text());
		expect(cues.map(({ text, startMs, endMs }) => ({ text, startMs, endMs }))).toEqual([
			{ text: "클립 전체 자막", startMs: 0, endMs: 5000 },
			{ text: "필요한 순간에 표시", startMs: 1000, endMs: 2500 },
		]);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "영상 내보내기" })));
		const exported = vi.mocked(exportVideo).mock.lastCall?.[0];
		expect(exported?.captions).toEqual([
			expect.objectContaining({ text: "필요한 순간에 표시", startMs: 1000, endMs: 2500 }),
		]);
		expect(exported?.captionStyle?.position).toBe("top");
		expect(exported?.clips[0].caption).toBe("클립 전체 자막");
	});

	it("keeps existing timed captions when SRT import fails and allows a successful replacement to be undone", async () => {
		const original = savedWorkspace();
		original.project.captions = [
			{
				id: "saved",
				text: "보존할 자막",
				startMs: 0,
				endMs: 1000,
				timestampMs: null,
				confidence: null,
			},
		];
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		await renderReady();
		const input = screen.getByLabelText("SRT 자막 파일");
		const invalid = new File(["invalid"], "invalid.srt");
		Object.defineProperty(invalid, "text", { value: async () => "this is not an SRT file" });
		await act(async () => fireEvent.change(input, { target: { files: [invalid] } }));
		expect(screen.getByText(/SRT 시간 형식이 올바르지 않습니다/)).toBeVisible();
		expect(screen.getByRole("textbox", { name: "시간 자막 내용" })).toHaveValue("보존할 자막");
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall?.[0].project.captions).toEqual(
			original.project.captions,
		);
		const valid = new File(["valid"], "valid.srt");
		Object.defineProperty(valid, "text", {
			value: async () => "1\n00:00:02,000 --> 00:00:04,000\n가져온 자막",
		});
		await act(async () => fireEvent.change(input, { target: { files: [valid] } }));
		expect(screen.getByRole("textbox", { name: "시간 자막 내용" })).toHaveValue("가져온 자막");
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.getByRole("textbox", { name: "시간 자막 내용" })).toHaveValue("보존할 자막");
	});
});

describe("timeline editing workflows", () => {
	it("applies a speed range across clips as one undoable edit and exports the restored result", async () => {
		const original = savedWorkspace();
		original.project.clips.push(createClip(original.assets[0]));
		original.project.clips[0].caption = "첫 장면";
		original.project.clips[0].zoomRegions = [
			{ id: "zoom", start: 3, end: 5, scale: 2, focusX: 0.25, focusY: 0.75 },
		];
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		const result = { blob: new Blob(["movie"]), extension: "mp4" as const };
		vi.mocked(exportVideo).mockResolvedValue(result);
		await renderReady();
		selectRange(4, 6);
		fireEvent.click(screen.getByRole("button", { name: "+ 속도" }));
		await finishSave();
		const edited = vi.mocked(saveWorkspace).mock.lastCall![0].project;
		expect(edited.clips.map((clip) => clip.speedRegions)).toEqual([
			[expect.objectContaining({ start: 4, end: 5, rate: 2 })],
			[expect.objectContaining({ start: 0, end: 1, rate: 2 })],
		]);
		expect(edited.clips[0].zoomRegions).toEqual(original.project.clips[0].zoomRegions);
		expect(edited.clips[0].caption).toBe("첫 장면");
		expect(getProjectDuration(edited)).toBe(9);
		expect(screen.getByRole("button", { name: "선택 구간 재생" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall![0].project).toEqual(original.project);
		fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "영상 내보내기" })));
		expect(vi.mocked(exportVideo).mock.lastCall![0]).toEqual(edited);
		expect(downloadBlob).toHaveBeenCalledWith(result.blob, `${original.project.title}.mp4`);
	});

	it("deletes the marked range before the selected clip and keeps editing shortcuts out of inputs", async () => {
		const original = savedWorkspace();
		const music: WebAsset = {
			...photo(),
			id: "music",
			name: "music.mp3",
			kind: "audio",
			duration: 8,
		};
		original.assets.push(music);
		original.project.audio = [createAudio(music)];
		original.project.captions = [
			{
				id: "caption",
				text: "시간 자막",
				startMs: 2500,
				endMs: 4000,
				timestampMs: null,
				confidence: null,
			},
		];
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.jpg/ }));
		selectRange(1, 2);
		const title = screen.getByRole("textbox", { name: "프로젝트 이름" });
		fireEvent.keyDown(title, { key: "Delete" });
		fireEvent.keyDown(title, { key: "s" });
		fireEvent.keyDown(title, { key: "z", ctrlKey: true });
		expect(screen.getByRole("button", { name: "실행 취소" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /01.*trip.jpg/ })).toBeVisible();
		fireEvent.keyDown(window, { key: "Delete" });
		await finishSave();
		const edited = vi.mocked(saveWorkspace).mock.lastCall![0];
		expect(
			edited.project.clips.map(({ trimStart, duration }) => ({ trimStart, duration })),
		).toEqual([
			{ trimStart: 0, duration: 1 },
			{ trimStart: 0, duration: 3 },
		]);
		expect(new Set(edited.project.clips.map((clip) => clip.id)).size).toBe(2);
		expect(edited.project.audio).toEqual(original.project.audio);
		expect(edited.project.captions).toEqual(original.project.captions);
		expect(edited.assets).toEqual(original.assets);
		expect(screen.getByRole("button", { name: "선택 구간 재생" })).toBeDisabled();
		fireEvent.keyDown(window, { key: "z", ctrlKey: true });
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall![0].project).toEqual(original.project);
	});

	it("deletes a selected effect before its containing clip", async () => {
		const original = savedWorkspace();
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.jpg/ }));
		fireEvent.click(screen.getByRole("button", { name: "+ 돋보기" }));
		expect(screen.getByRole("region", { name: "타임라인 구간 편집" })).toBeVisible();
		fireEvent.keyDown(window, { key: "Delete" });
		await finishSave();
		const clips = vi.mocked(saveWorkspace).mock.lastCall![0].project.clips;
		expect(clips).toHaveLength(1);
		expect(clips[0].duration).toBe(5);
		expect(clips[0].zoomRegions).toEqual([]);
		expect(screen.queryByRole("region", { name: "타임라인 구간 편집" })).not.toBeInTheDocument();
	});

	it("clears an undone effect selection so Delete can remove the selected clip", async () => {
		vi.mocked(loadWorkspace).mockResolvedValue(savedWorkspace());
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.jpg/ }));
		fireEvent.click(screen.getByRole("button", { name: "+ 속도" }));
		fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
		expect(screen.queryByRole("region", { name: "타임라인 구간 편집" })).not.toBeInTheDocument();
		fireEvent.keyDown(window, { key: "Delete" });
		await finishSave();
		expect(vi.mocked(saveWorkspace).mock.lastCall![0].project.clips).toEqual([]);
	});

	it("converts numeric source trims through speed regions and exposes extensions at normal speed", async () => {
		const original = savedWorkspace();
		original.assets[0] = { ...original.assets[0], kind: "video", name: "trip.mp4", duration: 12 };
		original.project.clips[0] = {
			...original.project.clips[0],
			trimStart: 2,
			duration: 6,
			speedRegions: [{ id: "speed", start: 1, end: 5, rate: 2 }],
		};
		vi.mocked(loadWorkspace).mockResolvedValue(original);
		await renderReady();
		fireEvent.click(screen.getByRole("button", { name: /01.*trip.mp4/ }));
		fireEvent.change(screen.getByRole("spinbutton", { name: "원본 구간 시작 (초)" }), {
			target: { value: "3" },
		});
		expect(screen.getByRole("spinbutton", { name: "원본 구간 길이 (초)" })).toHaveValue(5);
		fireEvent.change(screen.getByRole("spinbutton", { name: "원본 구간 길이 (초)" }), {
			target: { value: "3" },
		});
		await finishSave();
		let edited = vi.mocked(saveWorkspace).mock.lastCall![0].project;
		expect(edited.clips[0]).toMatchObject({
			trimStart: 3,
			duration: 3,
			speedRegions: [{ start: 0, end: 3, rate: 2 }],
		});
		expect(getProjectDuration(edited)).toBe(1.5);
		fireEvent.change(screen.getByRole("spinbutton", { name: "원본 구간 시작 (초)" }), {
			target: { value: "1" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: "원본 구간 길이 (초)" }), {
			target: { value: "6" },
		});
		await finishSave();
		edited = vi.mocked(saveWorkspace).mock.lastCall![0].project;
		expect(edited.clips[0]).toMatchObject({
			trimStart: 1,
			duration: 6,
			speedRegions: [{ start: 2, end: 5, rate: 2 }],
		});
		expect(getProjectDuration(edited)).toBe(4.5);
	});

	it("stops at the selected range end and clears that playback limit when seeking outside", async () => {
		vi.mocked(loadWorkspace).mockResolvedValue(savedWorkspace());
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
			window.setTimeout(() => callback(performance.now()), 16),
		);
		vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
		await renderReady();
		const playhead = screen.getByRole("slider", { name: "재생 위치" });
		fireEvent.change(playhead, { target: { value: "1" } });
		fireEvent.keyDown(window, { key: "i" });
		fireEvent.change(playhead, { target: { value: "2" } });
		fireEvent.keyDown(window, { key: "o" });
		fireEvent.click(screen.getByRole("button", { name: "선택 구간 재생" }));
		expect(playhead).toHaveValue("1");
		expect(screen.getByRole("button", { name: "일시 정지" })).toBeVisible();
		await act(async () => vi.advanceTimersByTimeAsync(1500));
		expect(playhead).toHaveValue("2");
		expect(screen.getByRole("button", { name: "재생" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "선택 구간 재생" }));
		fireEvent.change(playhead, { target: { value: "3" } });
		expect(playhead).toHaveValue("3");
		fireEvent.click(screen.getByRole("button", { name: "재생" }));
		await act(async () => vi.advanceTimersByTimeAsync(500));
		expect(Number((playhead as HTMLInputElement).value)).toBeGreaterThan(3.4);
		expect(Number((playhead as HTMLInputElement).value)).toBeLessThan(3.6);
		expect(screen.getByRole("button", { name: "일시 정지" })).toBeVisible();
	});
});
