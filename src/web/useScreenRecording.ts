import { useEffect, useRef, useState } from "react";

export function useScreenRecording(
	onComplete: (file: File) => void,
	onError: (error: unknown) => void,
) {
	const [recording, setRecording] = useState(false);
	const [starting, setStarting] = useState(false);
	const recorder = useRef<MediaRecorder | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const startPending = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (recorder.current?.state === "recording") recorder.current.stop();
			stream.current?.getTracks().forEach((track) => track.stop());
		};
	}, []);
	const supported =
		!!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
	const stop = () => {
		if (recorder.current?.state === "recording") recorder.current.stop();
	};
	const start = async () => {
		if (!supported || startPending.current || recorder.current) return;
		startPending.current = true;
		setStarting(true);
		try {
			const capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
			stream.current = capture;
			if (!mounted.current) {
				capture.getTracks().forEach((track) => track.stop());
				return;
			}
			const mimeType = [
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/mp4",
				"video/webm",
			].find((type) => MediaRecorder.isTypeSupported(type));
			const active = new MediaRecorder(capture, mimeType ? { mimeType } : undefined);
			recorder.current = active;
			const chunks: Blob[] = [];
			let failed = false;
			active.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			active.onerror = (event) => {
				failed = true;
				if (active.state === "recording") active.stop();
				capture.getTracks().forEach((track) => track.stop());
				stream.current = null;
				recorder.current = null;
				if (mounted.current) {
					setRecording(false);
					onError(new Error(`화면 녹화 중 오류가 발생했습니다: ${event.type}`));
				}
			};
			active.onstop = () => {
				capture.getTracks().forEach((track) => track.stop());
				stream.current = null;
				recorder.current = null;
				if (!mounted.current) return;
				setRecording(false);
				const type = active.mimeType || "video/webm";
				const extension = type.includes("mp4") ? "mp4" : "webm";
				if (chunks.length && !failed)
					onComplete(
						new File(
							chunks,
							`화면 녹화 ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
							{ type },
						),
					);
			};
			capture.getVideoTracks()[0].addEventListener(
				"ended",
				() => {
					if (active.state === "recording") active.stop();
				},
				{ once: true },
			);
			active.start(1_000);
			setRecording(true);
		} catch (error) {
			stream.current?.getTracks().forEach((track) => track.stop());
			stream.current = null;
			recorder.current = null;
			if (mounted.current && !(error instanceof DOMException && error.name === "NotAllowedError"))
				onError(error);
		} finally {
			startPending.current = false;
			if (mounted.current) setStarting(false);
		}
	};
	return { supported, recording, starting, start, stop };
}
