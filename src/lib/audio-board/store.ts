import { toast } from "sonner";
import { create } from "zustand";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { samePath } from "@/lib/media-board/board";
import { mutateDocument } from "@/lib/media-board/mutate";
import { applyMix, MIX_LABEL, mixSignature, mixSpec } from "./board";

/**
 * Applying the Audio board: the layers are mixed into one file in the main process, the file
 * becomes an asset, and the programme plays it alone. Kept in a store so the mix finishes — and
 * its result is reported — when the user leaves the Audio tab while it works.
 */

interface AudioMixState {
	applying: boolean;
	apply: () => Promise<boolean>;
}

/** The mixed file's asset: the one the project already has for it, or a new one. */
async function mixAsset(filePath: string): Promise<AxcutAsset | null> {
	const existing = useProjectStore
		.getState()
		.document?.assets.find(
			(asset) => asset.kind === "audio" && samePath(asset.originalPath, filePath),
		);
	return existing ?? useProjectStore.getState().addAudioAsset(filePath, MIX_LABEL);
}

/** How much quieter the layers must get for a peak of `peakDb` to fit, in percent. */
export function clippingCut(peakDb: number): number {
	return Math.ceil((1 - 10 ** (-peakDb / 20)) * 100);
}

export const useAudioMixStore = create<AudioMixState>((set, get) => ({
	applying: false,

	async apply() {
		if (get().applying) return false;
		const { document, projectId } = useProjectStore.getState();
		if (!document || !projectId) return false;
		const spec = mixSpec(document);
		if (!spec) {
			toast.error("반영할 오디오가 없습니다.", {
				description: "음악이나 나레이션을 가져오고, 소리가 나는 클립을 하나 이상 두세요.",
			});
			return false;
		}
		const createAudioMix = window.electronAPI?.createAudioMix;
		if (!createAudioMix) {
			toast.error("오디오 믹스는 Donqui Studio 데스크톱 앱에서 만들 수 있습니다.");
			return false;
		}
		const epoch = currentWriteEpoch();
		const superseded = () =>
			useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch;
		set({ applying: true });
		try {
			const result = await createAudioMix(spec);
			if (!result.success) throw new Error(result.error);
			if (superseded()) return false;
			const asset = await mixAsset(result.filePath);
			if (!asset || superseded()) return false;
			const signature = mixSignature(spec);
			const saved = await mutateDocument(
				(current) =>
					applyMix(current, { assetId: asset.id, durationSec: result.durationSec, signature }),
				{ history: true },
			);
			if (!saved) return false;
			toast.success(`오디오 믹스(${formatSeconds(result.durationSec)})를 Media에 반영했습니다.`, {
				description: `클립 ${spec.layers.length}개를 한 오디오로 섞었습니다.`,
			});
			// Above full scale, the 16-bit file could not hold the peak.
			if (result.peakDb !== null && result.peakDb > 0.05)
				toast.warning("믹스가 너무 커서 가장 큰 소리가 잘립니다.", {
					description: `클립 볼륨을 약 ${clippingCut(result.peakDb)}% 낮춰 다시 반영하세요.`,
				});
			return true;
		} catch (error) {
			toast.error("오디오를 반영하지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			set({ applying: false });
		}
	},
}));
