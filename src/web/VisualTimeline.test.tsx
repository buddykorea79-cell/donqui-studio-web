// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClip, createProject, type WebAsset } from "./project";
import { VisualTimeline } from "./VisualTimeline";

const video: WebAsset = {
	id: "video",
	name: "recording.mp4",
	kind: "video",
	duration: 20,
	blob: new Blob(["video"]),
};
const photo: WebAsset = {
	id: "photo",
	name: "photo.png",
	kind: "image",
	duration: 0,
	blob: new Blob(["image"]),
};
const project = {
	...createProject(),
	clips: [
		{ ...createClip(video), id: "v", trimStart: 2, duration: 5 },
		{ ...createClip(photo), id: "p", duration: 5 },
	],
};
type Props = ComponentProps<typeof VisualTimeline>;

function props(changes: Partial<Props> = {}): Props {
	return {
		project,
		assets: [video, photo],
		time: 0,
		selectedClipId: null,
		selection: null,
		disabled: false,
		range: null,
		playing: false,
		onSelectClip: vi.fn(),
		onSelectRegion: vi.fn(),
		onSeek: vi.fn(),
		onRangeChange: vi.fn(),
		onResizeClip: vi.fn(),
		onPlayFrom: vi.fn(),
		...changes,
	};
}

class TestPointerEvent extends MouseEvent {
	readonly pointerId: number;
	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
	}
}

beforeEach(() => {
	vi.stubGlobal("PointerEvent", TestPointerEvent);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* The initial layout effect measures synchronously in this fixture. */
			}
			disconnect() {
				/* No observer is retained by the fixture. */
			}
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
		this: HTMLElement,
	) {
		return this.classList.contains("vt-scroll") ? 1106 : 0;
	});
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const scroll = this.closest(".vt-scroll");
		const grid = this.closest<HTMLElement>(".vt-grid");
		const width = this.classList.contains("vt-ruler")
			? Number.parseFloat(grid?.style.width ?? "1106") - 106
			: 1106;
		const left = this.classList.contains("vt-ruler") ? 106 - (scroll?.scrollLeft ?? 0) : 0;
		return {
			x: left,
			y: 0,
			width,
			height: 30,
			top: 0,
			bottom: 30,
			left,
			right: left + width,
			toJSON: () => ({}),
		};
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("visual timeline navigation", () => {
	it("fits the complete timeline without making long movies wider until requested", () => {
		const long = { ...project, clips: [{ ...project.clips[1], duration: 86_400 }] };
		const view = render(<VisualTimeline {...props({ project: long })} />);
		expect(view.container.querySelector<HTMLElement>(".vt-grid")?.style.width).toBe("1106px");
		expect(screen.getByRole<HTMLInputElement>("slider", { name: "타임라인 확대 배율" }).value).toBe(
			"1",
		);
		fireEvent.click(screen.getByRole("button", { name: "타임라인 확대" }));
		expect(view.container.querySelector<HTMLElement>(".vt-grid")?.style.width).toBe("2106px");
		fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
		expect(view.container.querySelector<HTMLElement>(".vt-grid")?.style.width).toBe("1106px");
	});

	it("seeks at the pointed time, clamps dragging outside the ruler, and plays from a double click", () => {
		const p = props();
		render(<VisualTimeline {...p} />);
		const ruler = screen.getByRole("slider", { name: "타임라인 재생 위치" });
		const capture = vi.fn();
		const release = vi.fn();
		Object.assign(ruler, {
			setPointerCapture: capture,
			hasPointerCapture: () => true,
			releasePointerCapture: release,
		});
		fireEvent.pointerDown(ruler, { clientX: 356, pointerId: 7, button: 0 });
		expect(capture).toHaveBeenCalledWith(7);
		expect(p.onSeek).toHaveBeenLastCalledWith(2.5);
		fireEvent.pointerMove(ruler, { clientX: 2000, pointerId: 7 });
		expect(p.onSeek).toHaveBeenLastCalledWith(10);
		fireEvent.pointerUp(ruler, { clientX: 2000, pointerId: 7 });
		expect(release).toHaveBeenCalledWith(7);
		fireEvent.doubleClick(ruler, { clientX: 456 });
		expect(p.onPlayFrom).toHaveBeenLastCalledWith(3.5);
	});

	it("uses the scrolled and zoomed ruler bounds for clip clicks", () => {
		const p = props({ time: 5 });
		const view = render(<VisualTimeline {...p} />);
		fireEvent.click(screen.getByRole("button", { name: "타임라인 확대" }));
		const scroll = view.container.querySelector<HTMLElement>(".vt-scroll");
		expect(scroll?.scrollLeft).toBe(500);
		fireEvent.click(screen.getByRole("button", { name: /01 recording.mp4/ }), {
			clientX: 306,
			detail: 1,
		});
		expect(p.onSelectClip).toHaveBeenLastCalledWith("v", 3.5);
		fireEvent.doubleClick(screen.getByRole("button", { name: /01 recording.mp4/ }), {
			clientX: 306,
		});
		expect(p.onPlayFrom).toHaveBeenLastCalledWith(3.5);
	});

	it("fits a selected range and scrolls it into view", () => {
		const view = render(<VisualTimeline {...props({ range: { start: 6, end: 8 } })} />);
		fireEvent.click(screen.getByRole("button", { name: "선택 구간 확대" }));
		expect(screen.getByRole<HTMLInputElement>("slider", { name: "타임라인 확대 배율" }).value).toBe(
			"4.5",
		);
		expect(view.container.querySelector<HTMLElement>(".vt-scroll")?.scrollLeft).toBe(2684);
	});

	it("keeps the selected-range zoom label, slider, and canvas width consistent", () => {
		const view = render(<VisualTimeline {...props({ range: { start: 1, end: 2.17 } })} />);
		fireEvent.click(screen.getByRole("button", { name: "선택 구간 확대" }));
		expect(screen.getByRole<HTMLInputElement>("slider", { name: "타임라인 확대 배율" }).value).toBe(
			"7.75",
		);
		expect(screen.getByText("7.75×")).toBeTruthy();
		expect(view.container.querySelector<HTMLElement>(".vt-grid")?.style.width).toBe("7856px");
	});

	it("uses distinct precise ruler labels when zoomed in without adding sub-frame ticks", () => {
		const view = render(<VisualTimeline {...props()} />);
		fireEvent.change(screen.getByRole("slider", { name: "타임라인 확대 배율" }), {
			target: { value: "32" },
		});
		const labels = [...view.container.querySelectorAll(".vt-tick")].map((tick) => tick.textContent);
		expect(labels).toContain("00:00.06");
		expect(new Set(labels).size).toBe(labels.length);
		const short = { ...project, clips: [{ ...project.clips[1], duration: 1 / 30 }] };
		view.rerender(<VisualTimeline {...props({ project: short })} />);
		expect(view.container.querySelectorAll(".vt-tick")).toHaveLength(2);
	});

	it("moves by frames from the focused ruler and prevents the global shortcut from running twice", () => {
		const p = props({ time: 2 });
		const key = vi.fn();
		render(
			<div onKeyDown={key}>
				<VisualTimeline {...p} />
			</div>,
		);
		const ruler = screen.getByRole("slider", { name: "타임라인 재생 위치" });
		fireEvent.keyDown(ruler, { key: "ArrowRight" });
		expect(p.onSeek).toHaveBeenLastCalledWith(2 + 1 / 30);
		fireEvent.keyDown(ruler, { key: "End" });
		expect(p.onSeek).toHaveBeenLastCalledWith(10);
		fireEvent.keyDown(ruler, { key: "Enter" });
		expect(p.onPlayFrom).toHaveBeenLastCalledWith(2);
		expect(key).not.toHaveBeenCalled();
	});

	it("follows playback only when the playhead leaves the visible zoomed area", () => {
		const p = props({ playing: true });
		const view = render(<VisualTimeline {...p} />);
		fireEvent.click(screen.getByRole("button", { name: "타임라인 확대" }));
		const scroll = view.container.querySelector<HTMLElement>(".vt-scroll");
		view.rerender(<VisualTimeline {...p} time={7} />);
		expect(scroll?.scrollLeft).toBe(1150);
		view.rerender(<VisualTimeline {...p} time={8} />);
		expect(scroll?.scrollLeft).toBe(1150);
		expect(p.onSeek).not.toHaveBeenCalled();
	});
});

describe("visual timeline edit gestures", () => {
	it("selects a backwards drag once on release and shades the clips and effects", () => {
		const p = props();
		const view = render(<VisualTimeline {...p} />);
		const lane = screen.getByRole("group", { name: "구간 선택 트랙" });
		fireEvent.pointerDown(lane, { clientX: 706, pointerId: 2, button: 0 });
		fireEvent.pointerMove(lane, { clientX: 306, pointerId: 2 });
		expect(p.onRangeChange).not.toHaveBeenCalled();
		expect(view.container.querySelectorAll(".vt-selection-shade")).toHaveLength(4);
		fireEvent.pointerUp(lane, { clientX: 306, pointerId: 2 });
		expect(p.onRangeChange).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 6 });
	});

	it("keeps the existing range when a pointer selection is canceled", () => {
		const p = props({ range: { start: 1, end: 3 } });
		render(<VisualTimeline {...p} />);
		const lane = screen.getByRole("group", { name: "구간 선택 트랙" });
		fireEvent.pointerDown(lane, { clientX: 706, pointerId: 2, button: 0 });
		fireEvent.pointerMove(lane, { clientX: 906, pointerId: 2 });
		fireEvent.pointerCancel(lane, { pointerId: 2 });
		expect(p.onRangeChange).not.toHaveBeenCalled();
		expect(screen.getByText("00:01.0 ~ 00:03.0")).toBeTruthy();
	});

	it("moves a range edge without crossing the other edge, including keyboard edits", () => {
		const p = props({ range: { start: 1, end: 3 } });
		render(<VisualTimeline {...p} />);
		const handle = screen.getByRole("button", { name: "선택 구간 시작점" });
		fireEvent.pointerDown(handle, { clientX: 206, pointerId: 2, button: 0 });
		fireEvent.pointerUp(handle, { clientX: 906, pointerId: 2 });
		expect(p.onRangeChange).toHaveBeenLastCalledWith({ start: 3 - 1 / 30, end: 3 });
		fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
		expect(p.onRangeChange).toHaveBeenLastCalledWith({ start: 0, end: 3 });
	});

	it("previews a clip trim without changing the project and commits exactly once", () => {
		const p = props();
		const view = render(<VisualTimeline {...p} />);
		const handle = screen.getByRole("button", { name: "클립 1 끝점 조절" });
		fireEvent.pointerDown(handle, { clientX: 606, pointerId: 5, button: 0 });
		fireEvent.pointerMove(handle, { clientX: 406, pointerId: 5 });
		expect(p.onResizeClip).not.toHaveBeenCalled();
		expect(view.container.querySelector(".vt-resize-ghost")?.textContent).toBe("00:03.0");
		expect(project.clips[0].duration).toBe(5);
		fireEvent.pointerUp(handle, { clientX: 406, pointerId: 5 });
		expect(p.onResizeClip).toHaveBeenCalledExactlyOnceWith("v", "end", -2);
		expect(view.container.querySelector(".vt-resize-ghost")).toBeNull();
	});

	it("shows source-bounded extension and discards a trim on Escape", () => {
		const p = props();
		const view = render(<VisualTimeline {...p} />);
		const handle = screen.getByRole("button", { name: "클립 1 시작점 조절" });
		fireEvent.pointerDown(handle, { clientX: 106, pointerId: 5, button: 0 });
		fireEvent.pointerMove(handle, { clientX: -1000, pointerId: 5 });
		expect(view.container.querySelector(".vt-resize-ghost")?.textContent).toBe("00:07.0");
		// Pointer capture may leave keyboard focus on a control outside the timeline.
		fireEvent.keyDown(document.body, { key: "Escape" });
		fireEvent.pointerUp(handle, { clientX: -1000, pointerId: 5 });
		expect(p.onResizeClip).not.toHaveBeenCalled();
		expect(view.container.querySelector(".vt-resize-ghost")).toBeNull();
	});

	it("ignores gestures while exporting or importing", () => {
		const p = props({ disabled: true });
		render(<VisualTimeline {...p} />);
		const ruler = screen.getByRole("slider", { name: "타임라인 재생 위치" });
		fireEvent.pointerDown(ruler, { clientX: 500, pointerId: 1, button: 0 });
		fireEvent.doubleClick(ruler, { clientX: 500 });
		fireEvent.pointerDown(screen.getByRole("group", { name: "구간 선택 트랙" }), {
			clientX: 500,
			pointerId: 1,
			button: 0,
		});
		expect(p.onSeek).not.toHaveBeenCalled();
		expect(p.onPlayFrom).not.toHaveBeenCalled();
		expect(p.onRangeChange).not.toHaveBeenCalled();
	});
});
