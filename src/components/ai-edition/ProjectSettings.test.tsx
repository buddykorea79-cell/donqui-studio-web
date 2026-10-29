// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { getOutputSettings, loadOutputDefaults } from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { ProjectSettings } from "./ProjectSettings";

const initialProject = useProjectStore.getState();
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const current = () => useProjectStore.getState().document as AxcutDocument;

beforeEach(() => {
	save.mockClear();
	localStorage.clear();
	useProjectStore.setState({
		projectId: "p",
		document: createEmptyDocument({ projectId: "p", title: "Settings" }),
		saveDocument: save,
	});
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject, true);
});

describe("Settings", () => {
	it("sets the frame's shape, resolution and frame rate, and says what comes out", async () => {
		render(<ProjectSettings open onClose={vi.fn()} />);
		expect(screen.getByRole("status")).toHaveTextContent("최종 출력1920 × 1080·30fps");
		fireEvent.click(screen.getByRole("button", { name: /9:16 세로/ }));
		await waitFor(() => expect(getEditorSettings(current()).aspectRatio).toBe("9:16"));
		fireEvent.click(screen.getByRole("button", { name: /4K/ }));
		await waitFor(() => expect(getOutputSettings(current()).resolution).toBe("2160p"));
		fireEvent.click(screen.getByRole("button", { name: "60fps" }));
		await waitFor(() => expect(getOutputSettings(current()).fps).toBe(60));
		expect(screen.getByRole("status")).toHaveTextContent("2160 × 3840·60fps");
		expect(screen.getByRole("button", { name: /9:16 세로/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// Each choice is one undoable edit, and new projects will start from them.
		expect(save).toHaveBeenCalledTimes(3);
		expect(save.mock.calls.every((call) => call[1].history)).toBe(true);
		expect(loadOutputDefaults()).toEqual({ aspectRatio: "9:16", resolution: "2160p", fps: 60 });
	});

	it("fills the frame or floats the picture, and chooses how Media fits photos", async () => {
		render(<ProjectSettings open onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /꽉 채우기/ }));
		await waitFor(() => expect(getEditorSettings(current()).padding).toBe(0));
		fireEvent.click(screen.getByRole("button", { name: /전체 보이기/ }));
		await waitFor(() => expect(getOutputSettings(current()).mediaFit).toBe("contain"));
		fireEvent.click(screen.getByRole("button", { name: /배경 위에 띄우기/ }));
		await waitFor(() => expect(getEditorSettings(current()).padding).toBe(50));
	});

	it("asks for a project before anything can be set", () => {
		useProjectStore.setState({ document: null });
		render(<ProjectSettings open onClose={vi.fn()} />);
		expect(
			screen.getByText("프로젝트를 열거나 새로 만들면 설정할 수 있습니다."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /16:9/ })).not.toBeInTheDocument();
	});
});
