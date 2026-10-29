// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubtitles, subtitleEntries } from "@/lib/ai-edition/document/subtitles";
import { type AxcutClip, type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { type SubtitleDraft, SubtitlePane, SubtitleQuickBar } from "./SubtitleTools";

const mocks = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const initialProject = useProjectStore.getState();

function clip(start: number, end: number): AxcutClip {
	return {
		id: `c${start}`,
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: end - start,
		timelineStartSec: start,
		timelineEndSec: end,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function project(withClips = true) {
	const document = createEmptyDocument({ projectId: "p", title: "Subtitles" });
	if (withClips) document.timeline.clips = [clip(0, 20)];
	useProjectStore.setState({
		projectId: "p",
		document,
		currentTimeSec: 2,
		saveDocument: save,
	});
	return document;
}

const actions = { add: vi.fn(), edit: vi.fn(), reveal: vi.fn(), remove: vi.fn() };
const entries = () => subtitleEntries(useProjectStore.getState().document);

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject);
});

describe("the Subtitles panel", () => {
	it("opens the quick bar for a caption or a title, once there is video to put them on", () => {
		project(false);
		const { unmount } = render(<SubtitlePane actions={actions} />);
		expect(screen.getByRole("button", { name: /일반 자막/ })).toBeDisabled();
		unmount();
		project();
		render(<SubtitlePane actions={actions} />);
		fireEvent.click(screen.getByRole("button", { name: /일반 자막/ }));
		fireEvent.click(screen.getByRole("button", { name: /타이틀 Shift\+N/ }));
		expect(actions.add.mock.calls).toEqual([["caption"], ["title"]]);
	});

	it("restyles every subtitle of a kind when its look changes, in one step", async () => {
		const document = project();
		useProjectStore.setState({
			document: addSubtitles(document, [
				{ kind: "caption", text: "하나", startSec: 1, endSec: 2 },
				{ kind: "caption", text: "둘", startSec: 3, endSec: 4 },
				{ kind: "title", text: "제목", startSec: 5, endSec: 6 },
			]).document,
		});
		render(<SubtitlePane actions={actions} />);
		fireEvent.click(screen.getByRole("button", { name: "글자색 #ffe14d" }));
		await waitFor(() =>
			expect(
				useProjectStore
					.getState()
					.document?.annotations.map((region) => [region.content, region.style.color]),
			).toEqual([
				["하나", "#ffe14d"],
				["둘", "#ffe14d"],
				["제목", "#ffffff"],
			]),
		);
		fireEvent.change(screen.getByLabelText("자막 효과"), { target: { value: "typewriter" } });
		await waitFor(() =>
			expect(useProjectStore.getState().document?.annotations[0].style.textAnimation).toBe(
				"typewriter",
			),
		);
		expect(save).toHaveBeenCalledTimes(2);
		expect(save.mock.calls.every((call) => call[1].history)).toBe(true);
	});

	it("lists the subtitles in time order, and goes to, edits or removes one", () => {
		const document = project();
		useProjectStore.setState({
			document: addSubtitles(document, [
				{ kind: "title", text: "제목", startSec: 5, endSec: 6 },
				{ kind: "caption", text: "처음", startSec: 1, endSec: 2 },
			]).document,
		});
		render(<SubtitlePane actions={actions} />);
		const list = within(screen.getByRole("region", { name: "자막 목록" }));
		const items = list.getAllByRole("listitem");
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining("처음"),
			expect.stringContaining("제목"),
		]);
		fireEvent.click(within(items[1]).getByTitle("이 자막으로 가기"));
		expect(actions.reveal).toHaveBeenCalledWith(expect.objectContaining({ text: "제목" }));
		fireEvent.click(list.getByRole("button", { name: "처음 고치기" }));
		expect(actions.edit).toHaveBeenCalledWith(entries()[0].ids[0]);
		fireEvent.click(list.getByRole("button", { name: "처음 지우기" }));
		expect(actions.remove).toHaveBeenCalledWith(expect.objectContaining({ text: "처음" }));
	});

	it("puts in pasted SRT at its own times, and plain lines from the playhead", async () => {
		project();
		render(<SubtitlePane actions={actions} />);
		const field = screen.getByLabelText("가져올 자막");
		fireEvent.change(field, {
			target: {
				value: "1\n00:00:01,000 --> 00:00:03,000\n안녕\n\n2\n00:00:25,000 --> 00:00:26,000\n끝 뒤",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "자막으로 넣기" }));
		await waitFor(() => expect(entries()).toHaveLength(1));
		expect(entries()[0]).toMatchObject({ text: "안녕", startSec: 1, endSec: 3, kind: "caption" });
		expect(mocks.toast.success).toHaveBeenCalledWith("자막 1개를 넣었습니다.", {
			description: "영상이 끝난 뒤에 시작하는 1개는 뺐습니다.",
		});

		fireEvent.change(screen.getByLabelText("가져올 자막 종류"), { target: { value: "title" } });
		fireEvent.change(field, { target: { value: "첫 장면\n둘째 장면" } });
		fireEvent.click(screen.getByRole("button", { name: "자막으로 넣기" }));
		await waitFor(() => expect(entries()).toHaveLength(3));
		// From the playhead at 2 s — where the caption from 1 s still shows, so after it.
		expect(entries().slice(1)).toEqual([
			expect.objectContaining({ text: "첫 장면", kind: "title", startSec: 3 }),
			expect.objectContaining({ text: "둘째 장면", kind: "title" }),
		]);
	});
});

describe("the quick bar", () => {
	function renderBar(draft: Partial<SubtitleDraft> = {}) {
		const handlers = { onText: vi.fn(), onKind: vi.fn(), onCommit: vi.fn(), onClose: vi.fn() };
		render(
			<SubtitleQuickBar
				draft={{ kind: "caption", startSec: 12.3, text: "자막", ...draft }}
				durationSec={3}
				{...handlers}
			/>,
		);
		return { ...handlers, field: screen.getByLabelText("자막 내용") };
	}

	it("takes the text focused, and puts it in with Enter, or goes on with Ctrl+Enter", () => {
		const { field, onCommit, onText } = renderBar();
		expect(field).toHaveFocus();
		expect(screen.getByText("0:12.3부터 0:03.0")).toBeInTheDocument();
		fireEvent.change(field, { target: { value: "새 자막" } });
		expect(onText).toHaveBeenCalledWith("새 자막");
		fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
		expect(onCommit.mock.calls).toEqual([[false], [true]]);
	});

	it("leaves an Enter that ends a Korean composition to the input method", () => {
		const { field, onCommit } = renderBar();
		fireEvent.keyDown(field, { key: "Enter", isComposing: true });
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("switches kind while new, closes on Esc, and saves an edit without going on", () => {
		const { field, onKind, onClose } = renderBar();
		fireEvent.click(screen.getByRole("button", { name: "타이틀" }));
		expect(onKind).toHaveBeenCalledWith("title");
		fireEvent.keyDown(field, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
		cleanup();
		const edit = renderBar({ editId: "subtitle_1", kind: "title" });
		expect(screen.getByText("타이틀 고치기")).toBeInTheDocument();
		fireEvent.keyDown(edit.field, { key: "Enter", ctrlKey: true });
		expect(edit.onCommit).toHaveBeenCalledWith(false);
	});
});
