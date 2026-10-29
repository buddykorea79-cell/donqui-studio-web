import { toast } from "sonner";
import { create } from "zustand";
import { type ApplyMode, type ApplyProgress, applyComposition, cancelApply } from "./apply";

/**
 * Applying the composition renders effect clips one after another, which can take minutes. The
 * progress lives here rather than in Media, so it keeps going — and stays visible — when the
 * user switches tabs while it works.
 */

interface ComposeState {
	applying: (ApplyProgress & { mode: ApplyMode }) | null;
	apply: (mode: ApplyMode) => Promise<void>;
	cancel: () => void;
}

export const useComposeStore = create<ComposeState>((set, get) => ({
	applying: null,

	async apply(mode) {
		if (get().applying) return;
		set({ applying: { mode, done: 0, total: 0, label: "" } });
		try {
			const result = await applyComposition(mode, (progress) =>
				set({ applying: { mode, ...progress } }),
			);
			if (!result) toast.info("타임라인에 적용하지 않았습니다.");
			else if (result.placed === 0)
				toast.error("타임라인에 넣을 항목이 없습니다.", {
					description: "조합의 영상이나 사진 파일이 프로젝트에 없습니다.",
				});
			else
				toast.success(
					mode === "replace"
						? `조합 ${result.placed}개로 타임라인을 채웠습니다.`
						: `조합 ${result.placed}개를 타임라인 끝에 추가했습니다.`,
					result.skipped > 0
						? { description: `파일이 없는 ${result.skipped}개는 건너뛰었습니다.` }
						: undefined,
				);
		} catch (error) {
			toast.error("조합을 타임라인에 적용하지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			set({ applying: null });
		}
	},

	cancel: () => cancelApply(),
}));
