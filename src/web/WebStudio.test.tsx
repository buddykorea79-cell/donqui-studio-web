// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportVideo } from "./exportVideo";
import { downloadBlob, importMedia } from "./media";
import { createClip, createProject, type WebAsset, type WebWorkspace } from "./project";
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
		expect(screen.getByText("AI 장면 분석·자동 자막·고급 효과 미지원")).toBeVisible();
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
			caption: "여행 기록",
		};
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
		expect(clips?.[1].caption).toBe("여행 기록");
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
