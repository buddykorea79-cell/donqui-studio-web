import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { resolveExportProject } from "./resolveExportProject";

describe("current project exports", () => {
	it("preserves every asset, clip and authored subtitle", () => {
		const doc = createEmptyDocument({ projectId: "test", title: "Test" });
		doc.assets = ["one", "two"].map((id) => ({
			id,
			kind: "video",
			label: id,
			originalPath: id + ".mp4",
			cameraTrack: null,
		}));
		doc.timeline.clips = doc.assets.map((a, i) => ({
			id: a.id,
			assetId: a.id,
			sourceStartSec: 0,
			sourceEndSec: 3,
			timelineStartSec: i * 3,
			timelineEndSec: i * 3 + 3,
			wordRefs: [],
			origin: "user",
			reason: "import",
		}));
		expect(resolveExportProject(doc).document).toEqual(doc);
		expect(resolveExportProject(doc).project.media?.screenVideoPath).toBe("one.mp4");
	});
	it("rejects invalid input", () => {
		expect(() => resolveExportProject({})).toThrow();
	});
});
