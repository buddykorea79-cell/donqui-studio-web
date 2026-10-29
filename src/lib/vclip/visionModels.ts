import { create } from "zustand";
import type { VClipModelList } from "./contract";

/**
 * The local Ollama vision model V.Clip scores footage with. Chosen in the AI settings dialog
 * (the other AI options live there) and kept as a preference of this machine: it names a model
 * installed here, not something a project carries.
 */

const STORAGE_KEY = "donqui.vclip.visionModel";

/** Stored "" is "without AI"; nothing stored is "the lightest installed model". */
function readChoice(): string | null | undefined {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === null) return undefined;
		return stored === "" ? null : stored;
	} catch {
		return undefined;
	}
}

function writeChoice(choice: string | null): void {
	try {
		localStorage.setItem(STORAGE_KEY, choice ?? "");
	} catch {
		// A preference only: the choice still holds for this session.
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface VisionModelState {
	/** The user's pick: a model name, null for frame quality alone, undefined for the default. */
	chosen: string | null | undefined;
	models: VClipModelList | null;
	loading: boolean;
	load: () => Promise<void>;
	choose: (model: string | null) => void;
}

export const useVisionModelStore = create<VisionModelState>((set, get) => ({
	chosen: readChoice(),
	models: null,
	loading: false,

	async load() {
		if (get().loading) return;
		const list = window.electronAPI?.vclipListModels;
		if (!list) {
			set({
				models: {
					available: false,
					baseUrl: "",
					error: "V.Clip은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.",
					models: [],
				},
			});
			return;
		}
		set({ loading: true });
		try {
			set({ models: await list() });
		} catch (error) {
			set({ models: { available: false, baseUrl: "", error: message(error), models: [] } });
		} finally {
			set({ loading: false });
		}
	},

	choose(model) {
		writeChoice(model);
		set({ chosen: model });
	},
}));

/** The model a new analysis asks: the user's pick while installed, else the lightest one. */
export function effectiveModel(
	chosen: string | null | undefined,
	models: VClipModelList | null,
): string | null {
	const installed = models?.models ?? [];
	if (chosen === null) return null;
	if (chosen !== undefined && installed.some((model) => model.name === chosen)) return chosen;
	return installed[0]?.name ?? null;
}

export type VisionModelStatus =
	| { kind: "checking" }
	| { kind: "unavailable"; baseUrl: string; error: string | null }
	| { kind: "no-models"; baseUrl: string }
	| { kind: "off"; baseUrl: string; count: number }
	| { kind: "ready"; baseUrl: string; count: number; model: string };

/** Where V.Clip stands with Ollama, for the settings dialog and V.Clip's own status line. */
export function visionModelStatus(
	models: VClipModelList | null,
	loading: boolean,
	chosen: string | null | undefined,
): VisionModelStatus {
	if (loading || !models) return { kind: "checking" };
	if (!models.available)
		return { kind: "unavailable", baseUrl: models.baseUrl, error: models.error };
	if (models.models.length === 0) return { kind: "no-models", baseUrl: models.baseUrl };
	const model = effectiveModel(chosen, models);
	return model
		? { kind: "ready", baseUrl: models.baseUrl, count: models.models.length, model }
		: { kind: "off", baseUrl: models.baseUrl, count: models.models.length };
}
