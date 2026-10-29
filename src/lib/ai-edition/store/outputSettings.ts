import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";
import { type AspectRatio, isAspectRatio } from "@/utils/aspectRatioUtils";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import { type EditorSettingsPatch, getEditorSettings, patchEditorSettings } from "./editorSettings";

/**
 * Donqui Studio's output settings: the resolution a project is made at, its frame rate, and how
 * Media fits footage and photos into the frame. The frame's shape is the aspect ratio the editor
 * already stores (`editorSettings.aspectRatio`, which the compositor reads); these complete it.
 *
 * Kept in the `legacyEditor` envelope like every other appearance setting, so they round-trip
 * through save, load and undo with no schema bump, and an older build leaves them alone.
 */

export const OUTPUT_RESOLUTIONS = ["720p", "1080p", "2160p"] as const;
export type OutputResolution = (typeof OUTPUT_RESOLUTIONS)[number];

export const OUTPUT_FPS = [24, 30, 60] as const;
export type OutputFps = (typeof OUTPUT_FPS)[number];

/** `cover` fills the frame and may crop an edge; `contain` shows all of it, with bars. */
export type MediaFit = "cover" | "contain";

export interface OutputSettings {
	resolution: OutputResolution;
	fps: OutputFps;
	mediaFit: MediaFit;
}

export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
	resolution: "1080p",
	// Media renders its effects at 30 fps; a 60 fps export of them only repeats frames.
	fps: 30,
	mediaFit: "cover",
};

/** The frame's short side at each resolution. */
export const RESOLUTION_SHORT_SIDE: Record<OutputResolution, number> = {
	"720p": 720,
	"1080p": 1080,
	"2160p": 2160,
};

export const RESOLUTION_LABELS: Record<OutputResolution, string> = {
	"720p": "720p",
	"1080p": "1080p",
	"2160p": "4K",
};

function isOneOf<T extends string | number>(values: readonly T[], value: unknown): value is T {
	return (values as readonly unknown[]).includes(value);
}

export function getOutputSettings(document: AxcutDocument | null | undefined): OutputSettings {
	const legacy = document?.legacyEditor as Record<string, unknown> | null | undefined;
	return {
		resolution: isOneOf(OUTPUT_RESOLUTIONS, legacy?.outputResolution)
			? legacy.outputResolution
			: DEFAULT_OUTPUT_SETTINGS.resolution,
		fps: isOneOf(OUTPUT_FPS, legacy?.outputFps) ? legacy.outputFps : DEFAULT_OUTPUT_SETTINGS.fps,
		mediaFit:
			legacy?.mediaFit === "cover" || legacy?.mediaFit === "contain"
				? legacy.mediaFit
				: DEFAULT_OUTPUT_SETTINGS.mediaFit,
	};
}

export function patchOutputSettings(
	document: AxcutDocument,
	patch: Partial<OutputSettings>,
): AxcutDocument {
	const legacy = { ...((document.legacyEditor as Record<string, unknown> | null) ?? {}) };
	if (patch.resolution) legacy.outputResolution = patch.resolution;
	if (patch.fps) legacy.outputFps = patch.fps;
	if (patch.mediaFit) legacy.mediaFit = patch.mediaFit;
	return { ...document, legacyEditor: legacy };
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** The frame at `resolution` in the shape `aspect` (width / height), both sides even for H.264. */
export function outputFrameSize(
	aspect: number,
	resolution: OutputResolution,
): { width: number; height: number } {
	const short = RESOLUTION_SHORT_SIDE[resolution];
	const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
	return ratio >= 1
		? { width: even(short * ratio), height: short }
		: { width: short, height: even(short / ratio) };
}

/** The project's frame in pixels: its aspect ratio at its resolution. */
export function projectOutputFrame(document: AxcutDocument | null | undefined): {
	width: number;
	height: number;
} {
	const aspect = resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio);
	return outputFrameSize(aspect, getOutputSettings(document).resolution);
}

/**
 * The picture fills the whole frame: no padding, no rounded corners, no shadow, no frame. What
 * footage and photos want, as opposed to a screen recording floating over a wallpaper.
 */
export const FULL_FRAME_LAYOUT: EditorSettingsPatch = {
	padding: 0,
	borderRadius: 0,
	shadowIntensity: 0,
	frame: "none",
};

/** The screen-recorder look the editor starts from: the picture floats over the wallpaper. */
export const FLOATING_LAYOUT: EditorSettingsPatch = {
	padding: DEFAULT_PROJECT_APPEARANCE.padding,
	borderRadius: DEFAULT_PROJECT_APPEARANCE.borderRadius,
	shadowIntensity: DEFAULT_PROJECT_APPEARANCE.shadowIntensity,
};

export type Framing = "full" | "floating";

/**
 * How the picture sits in the frame: the choice made in Settings when there is one, else what
 * the layout amounts to. Media fills the frame unless the user chose to float the picture.
 */
export function getFraming(document: AxcutDocument | null | undefined): Framing {
	const stored = (document?.legacyEditor as Record<string, unknown> | null | undefined)?.framing;
	if (stored === "full" || stored === "floating") return stored;
	return getEditorSettings(document).padding === 0 ? "full" : "floating";
}

/** True once the user picked a framing in Settings — Media then leaves the layout alone. */
export function hasChosenFraming(document: AxcutDocument | null | undefined): boolean {
	const stored = (document?.legacyEditor as Record<string, unknown> | null | undefined)?.framing;
	return stored === "full" || stored === "floating";
}

export function withFraming(document: AxcutDocument, framing: Framing): AxcutDocument {
	const next = patchEditorSettings(
		document,
		framing === "full" ? FULL_FRAME_LAYOUT : FLOATING_LAYOUT,
	);
	return {
		...next,
		legacyEditor: { ...((next.legacyEditor as Record<string, unknown> | null) ?? {}), framing },
	};
}

// ─── What a new project starts from ───────────────────────────────────

const DEFAULTS_KEY = "donqui.output.defaults";

/** The settings last chosen in the Settings dialog, which a new project starts from. */
export interface OutputDefaults {
	aspectRatio?: AspectRatio;
	resolution?: OutputResolution;
	fps?: OutputFps;
	mediaFit?: MediaFit;
	framing?: Framing;
}

export function loadOutputDefaults(): OutputDefaults {
	let raw: unknown = null;
	try {
		raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? "null");
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	return {
		...(isAspectRatio(value.aspectRatio) && value.aspectRatio !== "native"
			? { aspectRatio: value.aspectRatio }
			: {}),
		...(isOneOf(OUTPUT_RESOLUTIONS, value.resolution) ? { resolution: value.resolution } : {}),
		...(isOneOf(OUTPUT_FPS, value.fps) ? { fps: value.fps } : {}),
		...(value.mediaFit === "cover" || value.mediaFit === "contain"
			? { mediaFit: value.mediaFit }
			: {}),
		...(value.framing === "full" || value.framing === "floating" ? { framing: value.framing } : {}),
	};
}

export function rememberOutputDefaults(patch: OutputDefaults): void {
	try {
		localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ ...loadOutputDefaults(), ...patch }));
	} catch {
		// A preference only: without storage, new projects start from the factory settings.
	}
}

/** A new project in the shape, resolution and framing last chosen in Settings. */
export function withOutputDefaults(
	document: AxcutDocument,
	defaults: OutputDefaults = loadOutputDefaults(),
): AxcutDocument {
	if (Object.keys(defaults).length === 0) return document;
	let next = document;
	if (defaults.aspectRatio) next = patchEditorSettings(next, { aspectRatio: defaults.aspectRatio });
	next = patchOutputSettings(next, defaults);
	if (defaults.framing) next = withFraming(next, defaults.framing);
	return next;
}
