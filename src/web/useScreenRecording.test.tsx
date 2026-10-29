// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenRecording } from "./useScreenRecording";

class FakeRecorder {
	static instances: FakeRecorder[] = [];
	static startError = false;
	static isTypeSupported = (type: string) => type.startsWith("video/webm");
	state: RecordingState = "inactive";
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
		this.mimeType = options?.mimeType ?? "video/webm";
		FakeRecorder.instances.push(this);
	}
	start() {
		if (FakeRecorder.startError) throw new Error("Encoder unavailable");
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({ data: new Blob(["recorded frames"], { type: this.mimeType }) });
		this.onstop?.();
	}
}

function captureStream() {
	const track = new EventTarget();
	const stop = vi.fn();
	Object.assign(track, { stop });
	return {
		track,
		stop,
		stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream,
	};
}

describe("browser screen recording lifecycle", () => {
	const getDisplayMedia = vi.fn<() => Promise<MediaStream>>();
	beforeEach(() => {
		getDisplayMedia.mockReset();
		FakeRecorder.instances = [];
		FakeRecorder.startError = false;
		vi.stubGlobal("MediaRecorder", FakeRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getDisplayMedia },
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	it("stops capture and imports the recorded file when screen sharing ends", async () => {
		const capture = captureStream();
		getDisplayMedia.mockResolvedValue(capture.stream);
		const complete = vi.fn();
		const error = vi.fn();
		const { result } = renderHook(() => useScreenRecording(complete, error));
		await act(() => result.current.start());
		expect(result.current.recording).toBe(true);
		act(() => capture.track.dispatchEvent(new Event("ended")));
		expect(result.current.recording).toBe(false);
		expect(capture.stop).toHaveBeenCalled();
		const file = complete.mock.calls[0][0] as File;
		expect(file.name).toMatch(/\.webm$/);
		expect(file.type).toBe("video/webm;codecs=vp9,opus");
		expect(file.size).toBeGreaterThan(0);
		expect(error).not.toHaveBeenCalled();
	});
	it("treats a dismissed permission picker as cancellation and allows another attempt", async () => {
		getDisplayMedia.mockRejectedValueOnce(new DOMException("Cancelled", "NotAllowedError"));
		const capture = captureStream();
		getDisplayMedia.mockResolvedValueOnce(capture.stream);
		const complete = vi.fn();
		const error = vi.fn();
		const { result, unmount } = renderHook(() => useScreenRecording(complete, error));
		await act(() => result.current.start());
		expect(result.current.starting).toBe(false);
		expect(error).not.toHaveBeenCalled();
		await act(() => result.current.start());
		expect(result.current.recording).toBe(true);
		unmount();
		expect(complete).not.toHaveBeenCalled();
		expect(capture.stop).toHaveBeenCalled();
	});
	it("does not open two permission requests when start is invoked before a rerender", async () => {
		const capture = captureStream();
		getDisplayMedia.mockResolvedValue(capture.stream);
		const { result, unmount } = renderHook(() => useScreenRecording(vi.fn(), vi.fn()));
		await act(async () => {
			await Promise.all([result.current.start(), result.current.start()]);
		});
		expect(getDisplayMedia).toHaveBeenCalledTimes(1);
		unmount();
	});
	it("releases a capture granted after the hook unmounts", async () => {
		const capture = captureStream();
		let grant: ((stream: MediaStream) => void) | undefined;
		getDisplayMedia.mockImplementation(
			() =>
				new Promise((resolve) => {
					grant = resolve;
				}),
		);
		const complete = vi.fn();
		const { result, unmount } = renderHook(() => useScreenRecording(complete, vi.fn()));
		let pending: Promise<void> | undefined;
		act(() => {
			pending = result.current.start();
		});
		unmount();
		grant?.(capture.stream);
		await pending;
		expect(capture.stop).toHaveBeenCalledOnce();
		expect(FakeRecorder.instances).toHaveLength(0);
		expect(complete).not.toHaveBeenCalled();
	});
	it("releases all capture tracks when the recorder cannot start", async () => {
		const capture = captureStream();
		getDisplayMedia.mockResolvedValue(capture.stream);
		FakeRecorder.startError = true;
		const error = vi.fn();
		const { result } = renderHook(() => useScreenRecording(vi.fn(), error));
		await act(() => result.current.start());
		expect(result.current.recording).toBe(false);
		expect(result.current.starting).toBe(false);
		expect(capture.stop).toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Encoder unavailable" }));
	});
	it("stops failed encoders without importing a partial recording as success", async () => {
		const capture = captureStream();
		getDisplayMedia.mockResolvedValue(capture.stream);
		const complete = vi.fn();
		const error = vi.fn();
		const { result } = renderHook(() => useScreenRecording(complete, error));
		await act(() => result.current.start());
		act(() => FakeRecorder.instances[0].onerror?.(new Event("error")));
		expect(result.current.recording).toBe(false);
		expect(capture.stop).toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledOnce();
	});
});
