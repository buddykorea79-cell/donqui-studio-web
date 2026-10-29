import { useEffect, useRef, useState } from "react";
import type { WebAsset, WebAudio, WebProject } from "./project";
import { drawFrame } from "./renderFrame";

function syncMedia(
	element: HTMLMediaElement,
	position: number,
	playing: boolean,
	volume: number,
	onError: (message: string) => void,
) {
	element.volume = Math.min(1, volume);
	if (
		Number.isFinite(position) &&
		Math.abs(element.currentTime - position) > (playing ? 0.25 : 0.015)
	) {
		element.currentTime = Math.max(0, position);
	}
	if (playing && element.paused)
		void element.play().catch((error: unknown) => {
			if (error instanceof DOMException && error.name === "AbortError") return;
			onError(
				"미디어를 재생할 수 없습니다. 지원하는 코덱인지 확인한 후 재생 버튼을 다시 눌러 주세요.",
			);
		});
	if (!playing && !element.paused) element.pause();
}

function AudioTrack({
	item,
	url,
	time,
	playing,
	onError,
}: {
	item: WebAudio;
	url: string;
	time: number;
	playing: boolean;
	onError: (message: string) => void;
}) {
	const ref = useRef<HTMLAudioElement>(null);
	useEffect(() => {
		const element = ref.current;
		return () => {
			element?.pause();
		};
	}, []);
	useEffect(() => {
		const audio = ref.current;
		if (!audio) return;
		const active = time >= item.start && time < item.start + item.duration;
		syncMedia(
			audio,
			item.trimStart + Math.max(0, time - item.start),
			active && playing,
			item.volume,
			onError,
		);
	}, [time, playing, item, onError]);
	return (
		<audio
			ref={ref}
			src={url}
			preload="auto"
			onError={() => onError("음원을 재생할 수 없습니다. WAV 또는 MP3 파일을 사용해 주세요.")}
		/>
	);
}

export function Preview({
	project,
	assets,
	urls,
	time,
	playing,
	onError,
}: {
	project: WebProject;
	assets: WebAsset[];
	urls: Map<string, string>;
	time: number;
	playing: boolean;
	onError: (message: string) => void;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const video = useRef<HTMLVideoElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const [loaded, setLoaded] = useState(0);
	let start = 0;
	const clip =
		project.clips.find((item, index) => {
			if (time < start + item.duration || index === project.clips.length - 1) return true;
			start += item.duration;
			return false;
		}) ?? null;
	const asset = assets.find((item) => item.id === clip?.assetId);
	const localTime = clip ? Math.min(clip.duration, Math.max(0, time - start)) : 0;
	const sourceUrl = asset && urls.get(asset.id);
	useEffect(() => {
		if (!sourceUrl) return;
		const element = video.current;
		return () => {
			element?.pause();
		};
	}, [sourceUrl]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Metadata and seek events must refresh playback even when the playhead is paused.
	useEffect(() => {
		if (video.current && clip)
			syncMedia(video.current, clip.trimStart + localTime, playing, clip.volume, onError);
	}, [clip, localTime, playing, loaded, onError]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Redraw after image/video loading and seek completion even when time has not changed.
	useEffect(() => {
		const context = canvas.current?.getContext("2d");
		if (!context) return;
		let frame = 0;
		const paint = () => {
			const source = asset?.kind === "image" ? image.current : video.current;
			const ready =
				source instanceof HTMLImageElement
					? source.complete && source.naturalWidth > 0
					: source instanceof HTMLVideoElement && source.readyState >= 2;
			drawFrame(context, ready ? source : null, clip, project.width, project.height, localTime);
			if (playing) frame = requestAnimationFrame(paint);
		};
		paint();
		return () => cancelAnimationFrame(frame);
	}, [clip, asset, project.width, project.height, localTime, playing, loaded]);
	return (
		<div className="preview-picture" style={{ aspectRatio: `${project.width}/${project.height}` }}>
			<canvas
				ref={canvas}
				width={project.width}
				height={project.height}
				aria-label="편집 영상 미리보기"
			/>
			<div className="media-sources" aria-hidden="true">
				{asset?.kind === "video" && (
					<video
						key={asset.id}
						ref={video}
						src={urls.get(asset.id)}
						playsInline
						preload="auto"
						onLoadedData={() => setLoaded((value) => value + 1)}
						onSeeked={() => setLoaded((value) => value + 1)}
						onError={() =>
							onError(
								`${asset.name}: 미리보기를 재생할 수 없습니다. H.264 MP4 또는 WebM 파일을 사용해 주세요.`,
							)
						}
					/>
				)}
				{asset?.kind === "image" && (
					<img
						key={asset.id}
						ref={image}
						src={urls.get(asset.id)}
						alt=""
						onLoad={() => setLoaded((value) => value + 1)}
					/>
				)}
				{project.audio.map((item) => (
					<AudioTrack
						key={item.id}
						item={item}
						url={urls.get(item.assetId) ?? ""}
						time={time}
						playing={playing}
						onError={onError}
					/>
				))}
			</div>
		</div>
	);
}
