// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebClip } from "./project";
import type { RegionSelection } from "./regionEditing";
import { TimelineRegionEditor } from "./TimelineRegionEditor";

afterEach(cleanup);

const clip: WebClip = {
	id: "clip",
	assetId: "video",
	trimStart: 3,
	duration: 10,
	volume: 1,
	effect: "none",
	caption: "",
	speedRegions: [
		{ id: "before", start: 0, end: 1, rate: 0.5 },
		{ id: "fast", start: 2, end: 6, rate: 2 },
		{ id: "after", start: 7, end: 9, rate: 0.5 },
	],
	zoomRegions: [
		{ id: "zoom", start: 2, end: 6, scale: 2, focusX: 0.5, focusY: 0.5, easeInOffset: 0.25 },
	],
};

function renderEditor(
	initial: WebClip = clip,
	selection: RegionSelection = { clipId: "clip", kind: "speed", id: "fast" },
) {
	const onChange = vi.fn<(change: Partial<WebClip>) => void>();
	const onSeek = vi.fn<(outputTime: number) => void>();
	const onClose = vi.fn();
	function Editor() {
		const [current, setCurrent] = useState(initial);
		return (
			<TimelineRegionEditor
				clip={current}
				selection={selection}
				onChange={(change) => {
					onChange(change);
					setCurrent((previous) => ({ ...previous, ...change }));
				}}
				onSeek={onSeek}
				onClose={onClose}
			/>
		);
	}
	return { ...render(<Editor />), onChange, onSeek, onClose };
}

describe("timeline region editor", () => {
	it("clamps edited edges to neighbours, keeps a positive range and ignores an empty field", () => {
		const { onChange } = renderEditor();
		const start = screen.getByLabelText("구간 시작 (초)");
		const end = screen.getByLabelText("구간 끝 (초)");
		fireEvent.change(start, { target: { value: "-1" } });
		expect(onChange.mock.lastCall?.[0].speedRegions?.[1].start).toBe(1);
		fireEvent.change(end, { target: { value: "20" } });
		expect(onChange.mock.lastCall?.[0].speedRegions?.[1].end).toBe(7);
		fireEvent.change(start, { target: { value: "20" } });
		expect(onChange.mock.lastCall?.[0].speedRegions?.[1].start).toBe(6.95);
		expect(onChange.mock.lastCall?.[0].speedRegions?.[0]).toEqual(clip.speedRegions?.[0]);
		expect(onChange.mock.lastCall?.[0].speedRegions?.[2]).toEqual(clip.speedRegions?.[2]);
		onChange.mockClear();
		fireEvent.change(start, { target: { value: "" } });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("changes only the selected speed, deletes that range and closes the editor", () => {
		const { onChange, onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("재생 속도"), { target: { value: "4" } });
		expect(onChange).toHaveBeenLastCalledWith({
			speedRegions: [
				clip.speedRegions?.[0],
				{ ...clip.speedRegions?.[1], rate: 4 },
				clip.speedRegions?.[2],
			],
		});
		fireEvent.click(screen.getByRole("button", { name: "구간 삭제" }));
		expect(onChange).toHaveBeenLastCalledWith({
			speedRegions: [clip.speedRegions?.[0], clip.speedRegions?.[2]],
		});
		expect(onClose).toHaveBeenCalledOnce();
		expect(screen.queryByRole("region", { name: "타임라인 구간 편집" })).toBeNull();
	});

	it("edits normalized zoom focus, retains easing phases, and supports focus presets", () => {
		const { onChange } = renderEditor(clip, { clipId: "clip", kind: "zoom", id: "zoom" });
		fireEvent.change(screen.getByLabelText("확대 중심 X (%)"), { target: { value: "80" } });
		fireEvent.change(screen.getByLabelText("확대 중심 Y (%)"), { target: { value: "25" } });
		fireEvent.change(screen.getByLabelText("확대 배율"), { target: { value: "9" } });
		expect(onChange).toHaveBeenLastCalledWith({
			zoomRegions: [{ ...clip.zoomRegions?.[0], focusX: 0.8, focusY: 0.25, scale: 5 }],
		});
		fireEvent.click(screen.getByRole("button", { name: "오른쪽 아래 확대" }));
		expect(onChange.mock.lastCall?.[0].zoomRegions?.[0]).toMatchObject({
			focusX: 1,
			focusY: 1,
			easeInOffset: 0.25,
		});
		expect(
			screen.getByRole("button", { name: "오른쪽 아래 확대" }).getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("seeks the zoom midpoint on the output timeline after 2× speed mapping", () => {
		const { onSeek } = renderEditor(
			{ ...clip, speedRegions: [{ id: "whole", start: 0, end: 10, rate: 2 }] },
			{ clipId: "clip", kind: "zoom", id: "zoom" },
		);
		fireEvent.click(screen.getByRole("button", { name: "구간 미리보기" }));
		expect(onSeek).toHaveBeenCalledWith(2);
	});

	it("closes without editing and safely renders no controls for a removed selection", () => {
		const { onClose, onChange, unmount } = renderEditor();
		fireEvent.click(screen.getByRole("button", { name: "구간 편집 닫기" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
		unmount();
		const missing = renderEditor(clip, { clipId: "clip", kind: "zoom", id: "removed" });
		expect(missing.container.childElementCount).toBe(0);
		expect(missing.onChange).not.toHaveBeenCalled();
	});
});
