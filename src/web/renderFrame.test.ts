import { describe, expect, it } from "vitest";
import { frameTransform } from "./renderFrame";

describe("frameTransform", () => {
	it("uses the same bounded zoom throughout preview and export", () => {
		expect(frameTransform("zoom-in", 0, 5).scale).toBe(1);
		expect(frameTransform("zoom-in", 5, 5).scale).toBeCloseTo(1.15);
		expect(frameTransform("zoom-out", 10, 5).scale).toBeCloseTo(1);
		expect(frameTransform("zoom-in", -1, 5).scale).toBe(1);
	});
	it("fades short clips across their half duration without negative opacity", () => {
		expect(frameTransform("fade", 0, 0.2).opacity).toBe(0);
		expect(frameTransform("fade", 0.1, 0.2).opacity).toBe(1);
		expect(frameTransform("fade", 0.2, 0.2).opacity).toBe(0);
		expect(frameTransform("fade", 0.3, 0.2).opacity).toBe(0);
	});
});
