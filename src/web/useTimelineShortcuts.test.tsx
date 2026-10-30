// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TimelineShortcuts, useTimelineShortcuts } from "./useTimelineShortcuts";

function callbacks(enabled = true) {
	return {
		enabled,
		onTogglePlay: vi.fn(),
		onSplit: vi.fn(),
		onDelete: vi.fn(),
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onSeekBy: vi.fn<(delta: number) => void>(),
		onSeekBoundary: vi.fn<(edge: "start" | "end") => void>(),
		onMarkStart: vi.fn(),
		onMarkEnd: vi.fn(),
		onClear: vi.fn(),
	} satisfies TimelineShortcuts;
}

function keyDown(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
	target.dispatchEvent(event);
	return event;
}

function expectNoActions(actions: ReturnType<typeof callbacks>) {
	for (const [name, action] of Object.entries(actions)) {
		if (name !== "enabled") expect(action).not.toHaveBeenCalled();
	}
}

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("timeline keyboard shortcuts", () => {
	it("runs the requested editing keys and cancels their browser defaults", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		for (const key of [" ", "s", "Delete", "Backspace", "i", "o", "Escape"])
			expect(keyDown(key).defaultPrevented).toBe(true);
		expect(actions.onTogglePlay).toHaveBeenCalledOnce();
		expect(actions.onSplit).toHaveBeenCalledOnce();
		expect(actions.onDelete).toHaveBeenCalledTimes(2);
		expect(actions.onMarkStart).toHaveBeenCalledOnce();
		expect(actions.onMarkEnd).toHaveBeenCalledOnce();
		expect(actions.onClear).toHaveBeenCalledOnce();
	});

	it("seeks by one output frame or one second and allows held arrow keys", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		keyDown("ArrowLeft");
		keyDown("ArrowRight", { repeat: true });
		keyDown("ArrowLeft", { shiftKey: true });
		keyDown("ArrowRight", { shiftKey: true, repeat: true });
		keyDown("Home");
		keyDown("End");
		expect(actions.onSeekBy.mock.calls).toEqual([[-1 / 30], [1 / 30], [-1], [1]]);
		expect(actions.onSeekBoundary.mock.calls).toEqual([["start"], ["end"]]);
	});

	it("supports Windows and Mac undo/redo without taking other modifier shortcuts", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		keyDown("z", { ctrlKey: true });
		keyDown("z", { metaKey: true });
		keyDown("Z", { ctrlKey: true, shiftKey: true });
		keyDown("Z", { metaKey: true, shiftKey: true });
		keyDown("y", { ctrlKey: true });
		expect(actions.onUndo).toHaveBeenCalledTimes(2);
		expect(actions.onRedo).toHaveBeenCalledTimes(3);
		for (const options of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ altKey: true },
			{ shiftKey: true },
		]) {
			for (const key of ["s", "Delete", "i", "o", " "])
				expect(keyDown(key, options).defaultPrevented).toBe(false);
		}
		expect(keyDown("z", { ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false);
		expect(keyDown("y", { metaKey: true }).defaultPrevented).toBe(false);
		expect(keyDown("y", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
		expect(actions.onSplit).not.toHaveBeenCalled();
		expect(actions.onDelete).not.toHaveBeenCalled();
	});

	it("uses the latest callbacks and enabled state with a single listener, then cleans it up", () => {
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		const original = callbacks();
		const updated = callbacks();
		const view = renderHook((props) => useTimelineShortcuts(props), { initialProps: original });
		view.rerender(updated);
		keyDown("s");
		expect(original.onSplit).not.toHaveBeenCalled();
		expect(updated.onSplit).toHaveBeenCalledOnce();
		view.rerender({ ...updated, enabled: false });
		for (const key of [" ", "s", "Delete", "ArrowRight", "Escape"])
			expect(keyDown(key).defaultPrevented).toBe(false);
		expect(updated.onSplit).toHaveBeenCalledOnce();
		expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
		view.unmount();
		keyDown("s");
		expect(updated.onSplit).toHaveBeenCalledOnce();
		expect(remove.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
	});

	it("leaves typing, native form editing, contenteditable descendants and dialog keys alone", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		for (const html of [
			"<input>",
			"<textarea></textarea>",
			"<select><option>Option</option></select>",
			'<div contenteditable="true"><span>text</span></div>',
			'<div contenteditable="plaintext-only"><span>text</span></div>',
			'<div role="textbox"><span>text</span></div>',
			"<dialog open><button>Close</button></dialog>",
			'<section role="dialog"><span>modal</span></section>',
			'<section role="alertdialog"><span>alert</span></section>',
		]) {
			document.body.innerHTML = html;
			const target = document.body.querySelector("span, button, input, textarea, select")!;
			for (const key of [" ", "s", "Delete", "Backspace", "ArrowRight", "Home", "i", "o", "Escape"])
				expect(keyDown(key, {}, target).defaultPrevented).toBe(false);
			expect(keyDown("z", { ctrlKey: true }, target).defaultPrevented).toBe(false);
		}
		expectNoActions(actions);
	});

	it("does not steal Space or navigation keys from focused buttons, links and ARIA widgets", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		for (const html of [
			"<button><span>Play</span></button>",
			'<a href="#"><span>Link</span></a>',
			'<div role="slider"><span>value</span></div>',
			'<div role="listbox"><span>item</span></div>',
			'<div role="tablist"><span>tab</span></div>',
			'<div role="checkbox"><span>label</span></div>',
		]) {
			document.body.innerHTML = html;
			const target = document.body.querySelector("span")!;
			for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End"])
				expect(keyDown(key, {}, target).defaultPrevented).toBe(false);
		}
		expectNoActions(actions);
	});

	it("ignores IME, previously handled keys and repeated destructive actions", () => {
		const actions = callbacks();
		renderHook(() => useTimelineShortcuts(actions));
		for (const key of [" ", "s", "Delete", "Backspace", "i", "o", "Escape"])
			expect(keyDown(key, { repeat: true }).defaultPrevented).toBe(false);
		keyDown("z", { ctrlKey: true, repeat: true });
		keyDown("Delete", { isComposing: true });
		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		event.preventDefault();
		window.dispatchEvent(event);
		expectNoActions(actions);
	});
});
