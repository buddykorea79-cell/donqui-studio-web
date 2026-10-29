// @vitest-environment jsdom
// The export dialog opens on the project's own settings — 설정's resolution and frame rate —
// and can still be changed for one export without writing anything back.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(async () => ({ videoDurationS: 12, wallS: 3 })),
	exportGifNative: vi.fn(async () => ({ videoDurationS: 12, wallS: 3 })),
	useIsCpuCompositor: () => false,
}));

vi.mock("@/native/sceneDescription", () => ({
	// `speedRegions` is what the export dialog reads to size the progress total
	// (`outputFrameCount`); an empty object here made it read `undefined`.
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { exportMultiNative } from "@/native";
import { ExportDialog } from "./ExportDialog";

type ElectronAPI = Window["electronAPI"];

const SAVED_PATH = "/tmp/openscreen/Test_project.mp4";

const noop = () => undefined;

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Test project",
		createdAt: "2026-06-26T10:00:00Z",
		updatedAt: "2026-06-26T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	legacyEditor: null,
};

function stubElectronAPI() {
	window.electronAPI = {
		pickExportSavePath: vi.fn(async () => ({ path: SAVED_PATH })),
		onNativeExportProgress: vi.fn(() => noop),
		revealInFolder: vi.fn(async () => ({ success: true })),
	} as unknown as ElectronAPI;
}

function renderDialog(document: AxcutDocument) {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={noop} document={document} />
		</I18nProvider>,
	);
}

describe("ExportDialog and the project's settings", () => {
	beforeEach(stubElectronAPI);
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("exports at the project's resolution and frame rate", async () => {
		renderDialog({ ...DOC, legacyEditor: { outputResolution: "2160p", outputFps: 24 } });
		fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
		await screen.findByTestId("export-show-in-folder");
		expect(exportMultiNative).toHaveBeenCalledWith(
			expect.anything(),
			SAVED_PATH,
			expect.any(String),
			expect.objectContaining({ width: 3840, height: 2160, fps: 24 }),
		);
	});

	it("opens on 1080p at 30 fps for a project that never chose", async () => {
		renderDialog(DOC);
		fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
		await waitFor(() =>
			expect(exportMultiNative).toHaveBeenCalledWith(
				expect.anything(),
				SAVED_PATH,
				expect.any(String),
				expect.objectContaining({ width: 1920, height: 1080, fps: 30 }),
			),
		);
	});
});
