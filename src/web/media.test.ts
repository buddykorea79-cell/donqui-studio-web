import { describe, expect, it } from "vitest";
import { assetKind, formatTime } from "./media";

describe("web media helpers", () => {
	it("recognizes file types when the OS omits a MIME type", () => {
		expect(assetKind({ name: "DRONE.MP4", type: "" })).toBe("video");
		expect(assetKind({ name: "music.m4a", type: "" })).toBe("audio");
		expect(assetKind({ name: "photo.JPG", type: "" })).toBe("image");
		expect(() => assetKind({ name: "secret.txt", type: "text/plain" })).toThrow();
	});
	it("formats duration and handles invalid metadata", () => {
		expect(formatTime(65.5)).toBe("01:05.5");
		expect(formatTime(6 + 0.8)).toBe("00:06.8");
		expect(formatTime(6.79)).toBe("00:06.7");
		expect(formatTime(Number.NaN)).toBe("00:00.0");
	});
});
