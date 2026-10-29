// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorDialogsProvider, useEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { useVisionModelStore } from "@/lib/vclip/visionModels";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () =>
				Promise.resolve({
					config: null,
					connectedProviders: [],
					availableProviders: [],
					credentialSummary: [],
				}),
			llmListProviderModels: () => Promise.resolve({ models: [] }),
		},
	},
}));

import { OllamaVisionSettings } from "./OllamaVisionSettings";
import { ProviderSettingsDialog } from "./ProviderSettings";

const list = vi.fn();
const initial = useVisionModelStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "ko-KR");
	useVisionModelStore.setState(
		{ ...initial, chosen: undefined, models: null, loading: false },
		true,
	);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { vclipListModels: list },
	});
	list.mockResolvedValue({
		available: true,
		baseUrl: "http://127.0.0.1:11434",
		error: null,
		models: [
			{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" },
			{ name: "qwen3-vl:8b", size: 6, parameterSize: "8.8B" },
		],
	});
});
afterEach(cleanup);

function renderSettings() {
	return render(
		<I18nProvider>
			<OllamaVisionSettings />
		</I18nProvider>,
	);
}

describe("OllamaVisionSettings", () => {
	it("lists the installed vision models, lightest first by default", async () => {
		renderSettings();
		expect(
			await screen.findByText(
				"http://127.0.0.1:11434에 연결됨 · 비전 모델 2개. 작은 모델일수록 빠릅니다.",
			),
		).toBeInTheDocument();
		const select = screen.getByLabelText("모델");
		expect(select).toHaveValue("qwen3-vl:4b");
		expect(
			within(select)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["qwen3-vl:4b · 4.4B", "qwen3-vl:8b · 8.8B", "AI 없이 (화질 점수만)"]);
		expect(screen.getByText("연결됨")).toBeInTheDocument();
	});

	it("keeps the pick for V.Clip, 'without AI' included", async () => {
		renderSettings();
		const select = await screen.findByLabelText("모델");
		await waitFor(() => expect(select).toBeEnabled());
		fireEvent.change(select, { target: { value: "qwen3-vl:8b" } });
		expect(useVisionModelStore.getState().chosen).toBe("qwen3-vl:8b");
		fireEvent.change(select, { target: { value: "" } });
		expect(useVisionModelStore.getState().chosen).toBeNull();
		expect(
			screen.getByText("V.Clip이 화질 점수로만 고릅니다. 설치된 비전 모델 2개."),
		).toBeInTheDocument();
	});

	it("says when Ollama is not running, and checks again on request", async () => {
		list.mockResolvedValueOnce({
			available: false,
			baseUrl: "http://127.0.0.1:11434",
			error: "fetch failed",
			models: [],
		});
		renderSettings();
		expect(
			await screen.findByText(/http:\/\/127\.0\.0\.1:11434의 Ollama에 연결할 수 없습니다/),
		).toBeInTheDocument();
		expect(screen.getByText("연결되지 않음")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
		await screen.findByText(/비전 모델 2개/);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("is part of the AI settings dialog", async () => {
		function OpenOnMount() {
			const { openDialog } = useEditorDialogActions();
			useEffect(() => openDialog("providers"), [openDialog]);
			return null;
		}
		render(
			<I18nProvider>
				<EditorDialogsProvider>
					<OpenOnMount />
					<ProviderSettingsDialog />
				</EditorDialogsProvider>
			</I18nProvider>,
		);
		expect(await screen.findByText("AI 설정")).toBeInTheDocument();
		expect(
			await screen.findByRole("region", { name: "로컬 비전 모델 (Ollama)" }),
		).toBeInTheDocument();
	});
});
