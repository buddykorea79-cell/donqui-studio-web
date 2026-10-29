// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VClipModelList } from "./contract";
import { effectiveModel, useVisionModelStore, visionModelStatus } from "./visionModels";

const installed: VClipModelList = {
	available: true,
	baseUrl: "http://127.0.0.1:11434",
	error: null,
	models: [
		{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" },
		{ name: "qwen3-vl:8b", size: 6, parameterSize: "8.8B" },
	],
};
const initial = useVisionModelStore.getState();

beforeEach(() => {
	localStorage.clear();
	useVisionModelStore.setState(
		{ ...initial, chosen: undefined, models: null, loading: false },
		true,
	);
});

describe("the model V.Clip asks", () => {
	it("is the lightest installed one until the user picks", () => {
		expect(effectiveModel(undefined, installed)).toBe("qwen3-vl:4b");
		expect(effectiveModel("qwen3-vl:8b", installed)).toBe("qwen3-vl:8b");
		expect(effectiveModel(null, installed)).toBeNull();
		// A pick that is no longer installed falls back.
		expect(effectiveModel("llava:7b", installed)).toBe("qwen3-vl:4b");
		expect(effectiveModel(undefined, null)).toBeNull();
	});

	it("keeps the pick across sessions, 'without AI' included", () => {
		useVisionModelStore.getState().choose("qwen3-vl:8b");
		expect(localStorage.getItem("donqui.vclip.visionModel")).toBe("qwen3-vl:8b");
		useVisionModelStore.getState().choose(null);
		expect(localStorage.getItem("donqui.vclip.visionModel")).toBe("");
		expect(useVisionModelStore.getState().chosen).toBeNull();
	});

	it("loads the list from the main process, and says so when there is none", async () => {
		const list = vi.fn(async () => installed);
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { vclipListModels: list },
		});
		await useVisionModelStore.getState().load();
		expect(useVisionModelStore.getState().models).toEqual(installed);

		Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined });
		await useVisionModelStore.getState().load();
		expect(useVisionModelStore.getState().models?.available).toBe(false);
	});

	it("reports where things stand", () => {
		expect(visionModelStatus(null, false, undefined)).toEqual({ kind: "checking" });
		expect(visionModelStatus(installed, true, undefined)).toEqual({ kind: "checking" });
		expect(
			visionModelStatus({ ...installed, available: false, error: "refused" }, false, undefined),
		).toEqual({ kind: "unavailable", baseUrl: installed.baseUrl, error: "refused" });
		expect(visionModelStatus({ ...installed, models: [] }, false, undefined)).toEqual({
			kind: "no-models",
			baseUrl: installed.baseUrl,
		});
		expect(visionModelStatus(installed, false, null)).toEqual({
			kind: "off",
			baseUrl: installed.baseUrl,
			count: 2,
		});
		expect(visionModelStatus(installed, false, "qwen3-vl:8b")).toEqual({
			kind: "ready",
			baseUrl: installed.baseUrl,
			count: 2,
			model: "qwen3-vl:8b",
		});
	});
});
