import { useEffect, useRef } from "react";
import { CLIP_EFFECT_FPS } from "../lib/clip-effects/catalog";

export type TimelineShortcuts = {
	enabled: boolean;
	onTogglePlay: () => void;
	onSplit: () => void;
	onDelete: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onSeekBy: (delta: number) => void;
	onSeekBoundary: (edge: "start" | "end") => void;
	onMarkStart: () => void;
	onMarkEnd: () => void;
	onClear: () => void;
};

const editingTarget =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog, [role="dialog"], [role="alertdialog"]';
const navigationTarget =
	'button, a[href], summary, [role="button"], [role="link"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="menuitem"], [role="tab"], [role="tablist"], [role="tree"], [role="treeitem"], [role="grid"], [role="checkbox"], [role="radio"], [role="switch"]';

/** Keep timeline keys available without taking editing or native widget keys from focused controls. */
export function useTimelineShortcuts(shortcuts: TimelineShortcuts) {
	const latest = useRef(shortcuts);
	latest.current = shortcuts;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const actions = latest.current;
			if (!actions.enabled || event.defaultPrevented || event.isComposing || event.altKey) return;
			const target =
				event.target instanceof Element
					? event.target
					: event.target instanceof Node
						? event.target.parentElement
						: null;
			if (target?.closest(editingTarget)) return;
			const key = event.key.toLowerCase();
			let action: (() => void) | undefined;
			if (event.ctrlKey || event.metaKey) {
				if (event.repeat || (event.ctrlKey && event.metaKey)) return;
				if (key === "z") action = event.shiftKey ? actions.onRedo : actions.onUndo;
				else if (event.ctrlKey && !event.shiftKey && key === "y") action = actions.onRedo;
			} else if (key === "arrowleft" || key === "arrowright") {
				if (target?.closest(navigationTarget)) return;
				const delta = (key === "arrowleft" ? -1 : 1) * (event.shiftKey ? 1 : 1 / CLIP_EFFECT_FPS);
				action = () => actions.onSeekBy(delta);
			} else if (!event.shiftKey && !event.repeat) {
				switch (key) {
					case " ":
					case "spacebar":
						if (!target?.closest(navigationTarget)) action = actions.onTogglePlay;
						break;
					case "s":
						action = actions.onSplit;
						break;
					case "delete":
					case "backspace":
						action = actions.onDelete;
						break;
					case "home":
					case "end":
						if (!target?.closest(navigationTarget))
							action = () => actions.onSeekBoundary(key === "home" ? "start" : "end");
						break;
					case "i":
						action = actions.onMarkStart;
						break;
					case "o":
						action = actions.onMarkEnd;
						break;
					case "escape":
						action = actions.onClear;
						break;
				}
			}
			if (!action) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
