// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import { getEditorSettings, patchEditorSettings } from "./editorSettings";
import {
	DEFAULT_OUTPUT_SETTINGS,
	getFraming,
	getOutputSettings,
	hasChosenFraming,
	loadOutputDefaults,
	outputFrameSize,
	patchOutputSettings,
	projectOutputFrame,
	rememberOutputDefaults,
	withFraming,
	withOutputDefaults,
} from "./outputSettings";

const blank = () => createEmptyDocument({ projectId: "p", title: "Output" });

afterEach(() => localStorage.clear());

describe("output settings", () => {
	it("default to 1080p at 30 fps, filling the frame", () => {
		expect(getOutputSettings(blank())).toEqual(DEFAULT_OUTPUT_SETTINGS);
		expect(getOutputSettings(null)).toEqual({ resolution: "1080p", fps: 30, mediaFit: "cover" });
	});

	it("read back what was set, and ignore what no build wrote", () => {
		const doc = patchOutputSettings(blank(), { resolution: "2160p", fps: 60, mediaFit: "contain" });
		expect(getOutputSettings(doc)).toEqual({ resolution: "2160p", fps: 60, mediaFit: "contain" });
		const odd = { ...blank(), legacyEditor: { outputResolution: "8k", outputFps: 29.97 } };
		expect(getOutputSettings(odd)).toEqual(DEFAULT_OUTPUT_SETTINGS);
	});

	it("size the frame by its short side, both sides even", () => {
		expect(outputFrameSize(16 / 9, "1080p")).toEqual({ width: 1920, height: 1080 });
		expect(outputFrameSize(9 / 16, "2160p")).toEqual({ width: 2160, height: 3840 });
		expect(outputFrameSize(4 / 3, "720p")).toEqual({ width: 960, height: 720 });
		expect(outputFrameSize(1, "1080p")).toEqual({ width: 1080, height: 1080 });
		const vertical = patchEditorSettings(blank(), { aspectRatio: "9:16" });
		expect(projectOutputFrame(vertical)).toEqual({ width: 1080, height: 1920 });
	});

	it("frame the picture fully or float it, and remember that it was chosen", () => {
		const doc = blank();
		expect(getFraming(doc)).toBe("floating");
		expect(hasChosenFraming(doc)).toBe(false);
		const full = withFraming(doc, "full");
		expect(getEditorSettings(full)).toMatchObject({
			padding: 0,
			borderRadius: 0,
			shadowIntensity: 0,
			frame: "none",
		});
		expect([getFraming(full), hasChosenFraming(full)]).toEqual(["full", true]);
		const floating = withFraming(full, "floating");
		expect(getEditorSettings(floating)).toMatchObject({ padding: 50, borderRadius: 40 });
		expect(getFraming(floating)).toBe("floating");
	});

	it("start a new project from the settings chosen last", () => {
		const doc = blank();
		expect(withOutputDefaults(doc)).toBe(doc);
		rememberOutputDefaults({ aspectRatio: "9:16", resolution: "720p" });
		rememberOutputDefaults({ framing: "full" });
		expect(loadOutputDefaults()).toEqual({
			aspectRatio: "9:16",
			resolution: "720p",
			framing: "full",
		});
		const fresh = withOutputDefaults(doc);
		expect(getEditorSettings(fresh)).toMatchObject({ aspectRatio: "9:16", padding: 0 });
		expect(getOutputSettings(fresh).resolution).toBe("720p");
		localStorage.setItem("donqui.output.defaults", "{not json");
		expect(loadOutputDefaults()).toEqual({});
	});
});
