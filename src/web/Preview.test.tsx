// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Preview } from "./Preview";
import { createAudio, createClip, createProject, type WebAsset } from "./project";

const assets: WebAsset[] = [
	{ id: "one", name: "one.mp4", kind: "video", duration: 5, blob: new Blob(["one"]) },
	{ id: "two", name: "two.mp4", kind: "video", duration: 5, blob: new Blob(["two"]) },
	{ id: "music", name: "music.mp3", kind: "audio", duration: 10, blob: new Blob(["audio"]) },
];
const urls = new Map(assets.map((asset) => [asset.id, `blob:${asset.id}`]));
const project = {
	...createProject(),
	clips: assets.slice(0, 2).map(createClip),
	audio: [{ ...createAudio(assets[2]), start: 3, trimStart: 2, duration: 4 }],
};

beforeEach(() => {
	const paused = new WeakMap<HTMLMediaElement, boolean>();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		return paused.get(this) ?? true;
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		paused.set(this, false);
		return Promise.resolve();
	});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		paused.set(this, true);
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("preview media lifecycle", () => {
	it("pauses the removed video when the timeline advances to another asset", () => {
		const onError = vi.fn();
		const view = render(
			<Preview project={project} assets={assets} urls={urls} time={1} playing onError={onError} />,
		);
		const previous = view.container.querySelector("video");
		expect(previous?.paused).toBe(false);
		view.rerender(
			<Preview project={project} assets={assets} urls={urls} time={6} playing onError={onError} />,
		);
		expect(previous?.paused).toBe(true);
		expect(view.container.querySelector("video")?.paused).toBe(false);
		expect(view.container.querySelector("video")?.currentTime).toBe(1);
	});

	it("plays trimmed audio only inside its timeline range and releases it on removal", () => {
		const onError = vi.fn();
		const view = render(
			<Preview project={project} assets={assets} urls={urls} time={1} playing onError={onError} />,
		);
		const audio = view.container.querySelector("audio");
		expect(audio?.paused).toBe(true);
		view.rerender(
			<Preview project={project} assets={assets} urls={urls} time={4} playing onError={onError} />,
		);
		expect(audio?.currentTime).toBe(3);
		expect(audio?.paused).toBe(false);
		view.rerender(
			<Preview project={project} assets={assets} urls={urls} time={8} playing onError={onError} />,
		);
		expect(audio?.paused).toBe(true);
		view.rerender(
			<Preview project={project} assets={assets} urls={urls} time={4} playing onError={onError} />,
		);
		expect(audio?.paused).toBe(false);
		view.rerender(
			<Preview
				project={{ ...project, audio: [] }}
				assets={assets}
				urls={urls}
				time={4}
				playing
				onError={onError}
			/>,
		);
		expect(audio?.paused).toBe(true);
	});

	it("pauses every playing media element on unmount", () => {
		const view = render(
			<Preview project={project} assets={assets} urls={urls} time={4} playing onError={vi.fn()} />,
		);
		const video = view.container.querySelector("video");
		const audio = view.container.querySelector("audio");
		expect(video?.paused).toBe(false);
		expect(audio?.paused).toBe(false);
		view.unmount();
		expect(video?.paused).toBe(true);
		expect(audio?.paused).toBe(true);
	});
});
