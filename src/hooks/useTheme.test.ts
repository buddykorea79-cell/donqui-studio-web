// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./useTheme";

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.classList.remove("dark");
});

describe("Donqui theme preferences", () => {
	it("retains a Mangopang light preference when upgrading", () => {
		localStorage.setItem("mangopang-theme", "light");
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("light");
		expect(localStorage.getItem("donqui-theme")).toBe("light");
		expect(localStorage.getItem("mangopang-theme")).toBe("light");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("uses the current preference before the legacy one and saves toggles", () => {
		localStorage.setItem("donqui-theme", "dark");
		localStorage.setItem("mangopang-theme", "light");
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("dark");
		act(() => result.current.toggle());
		expect(localStorage.getItem("donqui-theme")).toBe("light");
	});
});
