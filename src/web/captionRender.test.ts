import { describe, expect, it, vi } from "vitest";
import { drawCaptionOverlay } from "./captionRender";
import { DEFAULT_CAPTION_STYLE } from "./captions";

function canvasContext() {
	const context = {
		save: vi.fn(),
		restore: vi.fn(),
		setTransform: vi.fn(),
		fillRect: vi.fn(),
		fillText: vi.fn(),
		measureText: vi.fn((text: string) => ({ width: [...text].length * 20 })),
		font: "",
		globalAlpha: 0.2,
		textAlign: "start",
		textBaseline: "alphabetic",
		fillStyle: "",
	};
	return { context: context as unknown as CanvasRenderingContext2D, mock: context };
}

describe("browser caption overlay", () => {
	it("wraps Korean text within the video, preserves explicit lines and isolates effect transforms", () => {
		const { context, mock } = canvasContext();
		drawCaptionOverlay(context, "가나다라마바사아자차카타파하\n끝", 200, 360);
		expect(mock.fillText.mock.calls.map(([text]) => text)).toEqual([
			"가나다라마바사아",
			"자차카타파하",
			"끝",
		]);
		expect(
			mock.fillText.mock.calls.every(([, x, , maxWidth]) => x === 100 && maxWidth === 168),
		).toBe(true);
		expect(mock.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
		expect(mock.globalAlpha).toBe(1);
		expect(mock.save).toHaveBeenCalledOnce();
		expect(mock.restore).toHaveBeenCalledOnce();
		const [, top, , boxHeight] = mock.fillRect.mock.calls[0];
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top + boxHeight).toBeCloseTo(360 * 0.92);
	});

	it("uses a height-relative font and the selected color without a background", () => {
		const { context, mock } = canvasContext();
		drawCaptionOverlay(context, "한글 자막", 1280, 720, {
			...DEFAULT_CAPTION_STYLE,
			fontSize: 0.06,
			color: "#ffcc00",
			background: false,
		});
		expect(mock.font).toBe("600 43px system-ui, sans-serif");
		expect(mock.fillStyle).toBe("#ffcc00");
		expect(mock.fillRect).not.toHaveBeenCalled();
		expect(mock.fillText).toHaveBeenCalledOnce();
	});

	it("anchors top, center and bottom captions inside the output safe area", () => {
		const positions = ["top", "center", "bottom"] as const;
		const centers = positions.map((position) => {
			const { context, mock } = canvasContext();
			drawCaptionOverlay(context, "Caption", 640, 360, { ...DEFAULT_CAPTION_STYLE, position });
			const [, top, , height] = mock.fillRect.mock.calls[0];
			if (position === "top") expect(top).toBeCloseTo(360 * 0.08);
			if (position === "bottom") expect(top + height).toBeCloseTo(360 * 0.92);
			return top + height / 2;
		});
		expect(centers[0]).toBeLessThan(centers[1]);
		expect(centers[1]).toBe(180);
		expect(centers[2]).toBeGreaterThan(centers[1]);
	});

	it("keeps long subtitles within the frame and skips whitespace-only captions", () => {
		const { context, mock } = canvasContext();
		drawCaptionOverlay(context, "줄\n".repeat(100), 640, 360);
		const [, top, , height] = mock.fillRect.mock.calls[0];
		expect(top).toBeGreaterThan(0);
		expect(top + height).toBeLessThan(360);
		const empty = canvasContext();
		drawCaptionOverlay(empty.context, " \n\t ", 640, 360);
		expect(empty.mock.save).not.toHaveBeenCalled();
		expect(empty.mock.fillText).not.toHaveBeenCalled();
	});
});
