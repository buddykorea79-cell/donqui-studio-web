import { describe, expect, it, vi } from "vitest";
import { createProject } from "./project";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "./storage";

describe("browser storage failures", () => {
	it("reports unavailable IndexedDB instead of pretending a project was saved", async () => {
		vi.stubGlobal("indexedDB", undefined);
		try {
			await expect(loadWorkspace()).rejects.toThrow("저장소를 지원하지");
			await expect(saveWorkspace({ project: createProject(), assets: [] })).rejects.toThrow(
				"저장소를 지원하지",
			);
			await expect(clearWorkspace()).rejects.toThrow("저장소를 지원하지");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
