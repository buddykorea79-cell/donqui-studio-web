// @vitest-environment jsdom
// Subtitles are typed in Edit from the keyboard: N (or Shift+N for a title) opens the quick bar
// at the playhead, Enter puts the text in, Ctrl+Enter goes straight on to the next one where it
// ends, Enter or F2 on a selected subtitle retypes it, and [ / ] move its edges to the playhead.
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { subtitleEntries } from "@/lib/ai-edition/document/subtitles";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

const initialProject = useProjectStore.getState();
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});

/** Ten seconds of video on the timeline; no asset, so the preview stays an empty card. */
function project() {
	const document = createEmptyDocument({ projectId: "p", title: "Subtitles" });
	document.timeline.clips = [
		{
			id: "clip",
			assetId: "video",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "",
		},
	];
	return document;
}

function renderShell() {
	const view = render(
		<EditorDialogsProvider>
			<NewEditorShell />
		</EditorDialogsProvider>,
	);
	fireEvent.click(view.getByRole("tab", { name: "topbar.modes.edit" }));
	return view;
}

const press = (init: KeyboardEventInit) => fireEvent.keyDown(document.body, init);
const entries = () => subtitleEntries(useProjectStore.getState().document);

async function type(text: string, init: KeyboardEventInit = {}) {
	const field = await screen.findByLabelText("자막 내용");
	fireEvent.change(field, { target: { value: text } });
	await act(async () => {
		fireEvent.keyDown(field, { key: "Enter", ...init });
	});
}

beforeEach(() => {
	save.mockClear();
	useProjectStore.setState({
		projectId: "p",
		document: project(),
		currentTimeSec: 2,
		playing: false,
		saveDocument: save,
	});
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => undefined,
		setTitleBarOverlay: () => undefined,
		setHasUnsavedChanges: () => undefined,
		onRequestCloseConfirm: () => () => undefined,
		onRequestSaveBeforeClose: () => () => undefined,
		sendCloseConfirmResponse: () => undefined,
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
	};
	Element.prototype.scrollTo = () => undefined;
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
});

afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject, true);
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("subtitles from the keyboard", () => {
	it("puts a caption in at the playhead with N, type and Enter", async () => {
		renderShell();
		press({ key: "n" });
		expect(await screen.findByRole("dialog", { name: "자막 넣기" })).toBeInTheDocument();
		await type("안녕하세요");
		await waitFor(() => expect(entries()).toHaveLength(1));
		expect(entries()[0]).toMatchObject({
			text: "안녕하세요",
			kind: "caption",
			startSec: 2,
			endSec: 5,
		});
		expect(screen.queryByRole("dialog", { name: "자막 넣기" })).not.toBeInTheDocument();
		expect(save.mock.calls.every((call) => call[1].history)).toBe(true);
	});

	it("goes straight on to the next one with Ctrl+Enter, and closes on Esc", async () => {
		renderShell();
		press({ key: "N", shiftKey: true });
		await type("첫째 장", { ctrlKey: true });
		await waitFor(() => expect(entries()).toHaveLength(1));
		// A title lasts 3.5 s; the next one starts where it ends, and the playhead goes there.
		await waitFor(() => expect(useProjectStore.getState().currentTimeSec).toBeCloseTo(5.5, 3));
		await type("둘째 장", { ctrlKey: true });
		await waitFor(() => expect(entries()).toHaveLength(2));
		expect(
			entries().map((entry) => [entry.text, entry.kind, entry.startSec, entry.endSec]),
		).toEqual([
			["첫째 장", "title", 2, 5.5],
			["둘째 장", "title", 5.5, 9],
		]);
		fireEvent.keyDown(await screen.findByLabelText("자막 내용"), { key: "Escape" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("retypes the selected subtitle with Enter, and moves its edges to the playhead", async () => {
		renderShell();
		press({ key: "n" });
		await type("고치기 전");
		await waitFor(() => expect(entries()).toHaveLength(1));
		// Putting it in selected it: Enter opens it again, filled in.
		press({ key: "Enter" });
		const field = await screen.findByLabelText("자막 내용");
		expect(field).toHaveValue("고치기 전");
		expect(screen.getByRole("dialog", { name: "자막 고치기" })).toBeInTheDocument();
		await type("고친 뒤");
		await waitFor(() => expect(entries()[0].text).toBe("고친 뒤"));

		act(() => useProjectStore.setState({ currentTimeSec: 4 }));
		press({ key: "]" });
		await waitFor(() => expect(entries()[0].endSec).toBe(4));
		act(() => useProjectStore.setState({ currentTimeSec: 1 }));
		press({ key: "[" });
		await waitFor(() => expect(entries()[0].startSec).toBe(1));
	});
});
