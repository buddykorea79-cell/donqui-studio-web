import { describe, expect, it, vi } from "vitest";
import { CLIP_EFFECTS } from "../lib/clip-effects/catalog";
import { clipEffectTransform } from "../lib/clip-effects/motion";
import type { WebClip } from "./project";
import { drawFrame, frameTransform } from "./renderFrame";

describe("frameTransform", () => {
	it("uses the same bounded zoom throughout preview and export", () => {
		expect(frameTransform("zoom-in", 0, 5).scale).toBe(1);
		expect(frameTransform("zoom-in", 5, 5).scale).toBeCloseTo(1.16);
		expect(frameTransform("zoom-out", 10, 5).scale).toBeCloseTo(1);
		expect(frameTransform("zoom-in", -1, 5).scale).toBe(1);
	});
	it("fades short clips without negative opacity when seeking past their end", () => {
		expect(frameTransform("fade", 0, 0.2).opacity).toBe(0);
		expect(frameTransform("fade", 0.1, 0.2).opacity).toBe(1);
		expect(frameTransform("fade", 0.2, 0.2).opacity).toBe(0);
		expect(frameTransform("fade", 0.3, 0.2).opacity).toBe(0);
	});
	it("matches every desktop effect on each exported frame, including fractional preview times", () => {
		for (const { id } of CLIP_EFFECTS) {
			for (const frame of [0, 1, 7, 29, 58, 59]) {
				expect(frameTransform(id, frame / 30, 2)).toEqual(clipEffectTransform(id, frame, 60, 30));
				expect(frameTransform(id, frame / 30 + 0.005, 2)).toEqual(
					clipEffectTransform(id, frame, 60, 30),
				);
			}
		}
	});
});

function recordingContext() {
	return {
		save: vi.fn(),
		restore: vi.fn(),
		setTransform: vi.fn(),
		translate: vi.fn(),
		rotate: vi.fn(),
		scale: vi.fn(),
		fillRect: vi.fn(),
		drawImage: vi.fn(),
		fillText: vi.fn(),
		measureText: (text: string) => ({ width: text.length * 10 }),
		globalAlpha: 1,
		fillStyle: "",
	};
}

const clip: WebClip = {
	id: "photo-clip",
	assetId: "photo",
	trimStart: 0,
	duration: 2,
	volume: 1,
	effect: "none",
	caption: "",
};
const portrait = { width: 300, height: 600 } as HTMLCanvasElement;

describe("canvas effect framing", () => {
	it("zooms around the selected frame position without moving captions", () => {
		const context = recordingContext();
		drawFrame(
			context as unknown as CanvasRenderingContext2D,
			portrait,
			{
				...clip,
				caption: "확대해도 같은 자막",
				zoomRegions: [{ id: "zoom", start: 0, end: 2, scale: 2, focusX: 0.75, focusY: 0.25 }],
			},
			640,
			360,
			1,
		);
		expect(context.translate).toHaveBeenCalledWith(-640, 0);
		expect(context.scale).toHaveBeenCalledWith(2, 2);
		expect(context.restore.mock.invocationCallOrder[0]).toBeLessThan(
			context.fillText.mock.invocationCallOrder[0],
		);
		expect(context.fillText).toHaveBeenCalledWith(
			"확대해도 같은 자막",
			320,
			expect.any(Number),
			640 * 0.84,
		);
	});

	it("uses output duration for the existing motion effects on a sped-up clip", () => {
		const context = recordingContext();
		drawFrame(
			context as unknown as CanvasRenderingContext2D,
			portrait,
			{
				...clip,
				effect: "zoom-in",
				speedRegions: [{ id: "speed", start: 0, end: 2, rate: 2 }],
			},
			640,
			360,
			0.5,
		);
		expect(context.scale).toHaveBeenCalledWith(
			frameTransform("zoom-in", 0.5, 1).scale,
			frameTransform("zoom-in", 0.5, 1).scale,
		);
	});

	it("contains the entire portrait by default and centers it in the landscape frame", () => {
		const context = recordingContext();
		drawFrame(context as unknown as CanvasRenderingContext2D, portrait, clip, 640, 360, 0);
		expect(context.translate).toHaveBeenCalledWith(320, 180);
		expect(context.drawImage).toHaveBeenCalledWith(portrait, -90, -180, 180, 360);
	});

	it("crops the source before cover and tilt so extra source pixels cannot leak through corners", () => {
		const context = recordingContext();
		drawFrame(
			context as unknown as CanvasRenderingContext2D,
			portrait,
			{ ...clip, effect: "tilt", fit: "cover" },
			640,
			360,
			0,
		);
		expect(context.drawImage).toHaveBeenCalledWith(
			portrait,
			0,
			215.625,
			300,
			168.75,
			-320,
			-180,
			640,
			360,
		);
		expect(context.rotate).toHaveBeenCalledWith((-2 * Math.PI) / 180);
		expect(context.scale).toHaveBeenCalledWith(1.12, 1.12);
	});

	it("translates pans by the output frame width, not the fitted portrait width", () => {
		const context = recordingContext();
		drawFrame(
			context as unknown as CanvasRenderingContext2D,
			portrait,
			{ ...clip, effect: "pan-left" },
			640,
			360,
			0,
		);
		expect(context.translate).toHaveBeenCalledWith(345.6, 180);
		expect(context.scale).toHaveBeenCalledWith(1.18, 1.18);
	});

	it("restores the image effect before drawing captions so faded or tilted clips keep legible text", () => {
		const context = recordingContext();
		drawFrame(
			context as unknown as CanvasRenderingContext2D,
			portrait,
			{ ...clip, effect: "fade", caption: "고정된 자막" },
			640,
			360,
			0,
		);
		expect(context.restore.mock.invocationCallOrder[0]).toBeLessThan(
			context.fillText.mock.invocationCallOrder[0],
		);
		expect(context.globalAlpha).toBe(1);
		expect(context.fillText).toHaveBeenCalledWith(
			"고정된 자막",
			320,
			expect.any(Number),
			640 * 0.84,
		);
	});
});
