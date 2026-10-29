// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionEditor } from "./CaptionEditor";
import { DEFAULT_CAPTION_STYLE, type WebCaption } from "./captions";
import { createProject, type WebProject } from "./project";

afterEach(cleanup);

const cue: WebCaption = {
	id: "first",
	text: "첫 번째 자막",
	startMs: 1000,
	endMs: 3000,
	timestampMs: null,
	confidence: null,
};

function renderEditor(initial: Partial<WebProject> = {}, time = 1, duration = 5) {
	const onChange = vi.fn<(change: Partial<WebProject>) => void>();
	const onSeek = vi.fn();
	const onImport = vi.fn();
	const onExport = vi.fn();
	function Editor() {
		const [project, setProject] = useState({ ...createProject(), ...initial });
		return (
			<CaptionEditor
				project={project}
				time={time}
				duration={duration}
				onChange={(change) => {
					onChange(change);
					setProject((current) => ({ ...current, ...change }));
				}}
				onSeek={onSeek}
				onImport={onImport}
				onExport={onExport}
			/>
		);
	}
	return { ...render(<Editor />), onChange, onSeek, onImport, onExport };
}

describe("caption editor", () => {
	it("updates styles without dropping other settings or editing caption text", () => {
		const { onChange } = renderEditor({ captions: [cue] });
		fireEvent.change(screen.getByLabelText("자막 위치"), { target: { value: "top" } });
		fireEvent.change(screen.getByLabelText(/자막 크기/), { target: { value: "6" } });
		fireEvent.change(screen.getByLabelText("자막 색상"), { target: { value: "#aabbcc" } });
		fireEvent.click(screen.getByLabelText("자막 배경 표시"));
		expect(onChange).toHaveBeenLastCalledWith({
			captionStyle: {
				...DEFAULT_CAPTION_STYLE,
				position: "top",
				fontSize: 0.06,
				color: "#aabbcc",
				background: false,
			},
		});
		expect((screen.getByLabelText("시간 자막 내용") as HTMLTextAreaElement).value).toBe(cue.text);
	});

	it("adds a visible cue at the end of the timeline and seeks to its actual start", () => {
		const { onChange, onSeek } = renderEditor({}, 5, 5);
		fireEvent.click(screen.getByRole("button", { name: "현재 위치에 자막 추가" }));
		const added = onChange.mock.calls[0][0].captions?.[0];
		expect(added).toMatchObject({ startMs: 4900, endMs: 5000, text: "새 자막" });
		expect(added?.id).toBeTruthy();
		expect(onSeek).toHaveBeenLastCalledWith(4.9);
		expect((screen.getByLabelText("시간 자막 내용") as HTMLTextAreaElement).value).toBe("새 자막");
	});

	it("keeps edited ranges positive and ignores an empty time field", () => {
		const { onChange } = renderEditor({ captions: [cue] });
		const start = screen.getByLabelText("자막 시작 (초)");
		const end = screen.getByLabelText("자막 끝 (초)");
		fireEvent.change(start, { target: { value: "20" } });
		expect(onChange.mock.lastCall?.[0].captions?.[0].startMs).toBe(2999);
		fireEvent.change(end, { target: { value: "0" } });
		expect(onChange.mock.lastCall?.[0].captions?.[0].endMs).toBe(3000);
		fireEvent.change(start, { target: { value: "-1" } });
		expect(onChange.mock.lastCall?.[0].captions?.[0].startMs).toBe(0);
		fireEvent.change(end, { target: { value: "999999" } });
		expect(onChange.mock.lastCall?.[0].captions?.[0].endMs).toBe(86_400_000);
		onChange.mockClear();
		fireEvent.change(start, { target: { value: "" } });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("selects, edits and deletes only the chosen cue", () => {
		const second = { ...cue, id: "second", startMs: 3500, endMs: 4500, text: "두 번째" };
		const { onChange, onSeek } = renderEditor({ captions: [cue, second] });
		fireEvent.change(screen.getByLabelText("시간 자막 선택"), { target: { value: "second" } });
		expect(onSeek).toHaveBeenLastCalledWith(3.5);
		fireEvent.change(screen.getByLabelText("시간 자막 내용"), {
			target: { value: "수정한 한글\n두 줄 자막" },
		});
		expect(onChange.mock.lastCall?.[0].captions).toEqual([
			cue,
			{ ...second, text: "수정한 한글\n두 줄 자막" },
		]);
		fireEvent.click(screen.getByRole("button", { name: "선택 자막 삭제" }));
		expect(onChange).toHaveBeenLastCalledWith({ captions: [cue] });
		expect((screen.getByLabelText("시간 자막 내용") as HTMLTextAreaElement).value).toBe(cue.text);
	});

	it("passes the selected SRT file and export action to their callbacks", () => {
		const { onImport, onExport } = renderEditor({ captions: [cue] });
		const file = new File(["1\n00:00:00,000 --> 00:00:01,000\n자막"], "captions.srt", {
			type: "application/x-subrip",
		});
		fireEvent.change(screen.getByLabelText("SRT 자막 파일"), { target: { files: [file] } });
		expect(onImport).toHaveBeenCalledWith(file);
		fireEvent.click(screen.getByRole("button", { name: "SRT 저장" }));
		expect(onExport).toHaveBeenCalledOnce();
	});

	it("disables adding and exporting captions for an empty project", () => {
		const { onChange, onExport } = renderEditor({}, 0, 0);
		fireEvent.click(screen.getByRole("button", { name: "현재 위치에 자막 추가" }));
		fireEvent.click(screen.getByRole("button", { name: "SRT 저장" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(onExport).not.toHaveBeenCalled();
	});
});
