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
	it.each([
		"video",
		"image",
	] as const)("waits for object URLs before mounting %s and audio sources during backup restore", (kind) => {
		const visual = { ...assets[0], kind };
		const restoredAssets = [visual, assets[2]];
		const restored = { ...project, clips: [createClip(visual)] };
		const onError = vi.fn();
		const view = render(
			<Preview
				project={restored}
				assets={restoredAssets}
				urls={new Map()}
				time={4}
				playing
				onError={onError}
			/>,
		);
		// An empty src can request the document URL and raise a spurious codec error.
		expect(view.container.querySelector("video, audio, img")).toBeNull();
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
		view.rerender(
			<Preview
				project={restored}
				assets={restoredAssets}
				urls={urls}
				time={4}
				playing
				onError={onError}
			/>,
		);
		expect(
			view.container.querySelector(kind === "video" ? "video" : "img")?.getAttribute("src"),
		).toBe("blob:one");
		const audio = view.container.querySelector("audio");
		expect(audio?.getAttribute("src")).toBe("blob:music");
		expect(audio?.currentTime).toBe(3);
		expect(audio?.paused).toBe(false);
		if (kind === "video") {
			expect(view.container.querySelector("video")?.currentTime).toBe(4);
			expect(view.container.querySelector("video")?.paused).toBe(false);
		}
		expect(onError).not.toHaveBeenCalled();
	});
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
	it("maps speed regions to source time and restores normal speed at the region end", () => {
		const sped = {
			...project,
			clips: [
				{
					...project.clips[0],
					speedRegions: [{ id: "fast", start: 1, end: 3, rate: 2 }],
				},
				project.clips[1],
			],
		};
		const onError = vi.fn();
		const view = render(
			<Preview project={sped} assets={assets} urls={urls} time={1.5} playing onError={onError} />,
		);
		const video = view.container.querySelector("video");
		expect(video?.currentTime).toBe(2);
		expect(video?.playbackRate).toBe(2);
		expect(video?.preservesPitch).toBe(false);
		view.rerender(
			<Preview project={sped} assets={assets} urls={urls} time={2} playing onError={onError} />,
		);
		expect(video?.currentTime).toBe(3);
		expect(video?.playbackRate).toBe(1);
		view.rerender(
			<Preview project={sped} assets={assets} urls={urls} time={4.2} playing onError={onError} />,
		);
		expect(video?.paused).toBe(true);
		expect(view.container.querySelector("video")?.currentTime).toBeCloseTo(0.2);
		expect(view.container.querySelector("video")?.playbackRate).toBe(1);
	});
	it("slows only clip audio and leaves background music on the output timeline", () => {
		const slow = {
			...project,
			clips: [{ ...project.clips[0], speedRegions: [{ id: "slow", start: 1, end: 4, rate: 0.5 }] }],
		};
		const view = render(
			<Preview project={slow} assets={assets} urls={urls} time={4} playing onError={vi.fn()} />,
		);
		expect(view.container.querySelector("video")?.currentTime).toBe(2.5);
		expect(view.container.querySelector("video")?.playbackRate).toBe(0.5);
		expect(view.container.querySelector("audio")?.currentTime).toBe(3);
		expect(view.container.querySelector("audio")?.playbackRate).toBe(1);
	});
});
