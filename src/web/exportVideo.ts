import {
	ALL_FORMATS,
	AudioBufferSink,
	AudioBufferSource,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	canEncodeAudio,
	canEncodeVideo,
	Input,
	type InputAudioTrack,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import { CLIP_EFFECT_FPS } from "../lib/clip-effects/catalog";
import {
	getProjectDuration,
	getProjectFrameCount,
	type WebAsset,
	type WebProject,
} from "./project";
import { drawFrame } from "./renderFrame";
import { clipOutputToSourceTime, getClipOutputDuration, getClipTiming } from "./timelineEffects";

const FPS = CLIP_EFFECT_FPS;
const SAMPLE_RATE = 48_000;
const AUDIO_BLOCK_SECONDS = 10;

export interface ExportOptions {
	signal?: AbortSignal;
	onProgress?: (progress: number) => void;
}

export type ExportEncoding = {
	extension: "mp4" | "webm";
	video: "avc" | "vp9" | "vp8";
	audio: "aac" | "opus";
};

/** Probe the actual output dimensions: support can vary with resolution and hardware. */
export async function chooseExportEncoding(
	width: number,
	height: number,
	hasAudio: boolean,
): Promise<ExportEncoding> {
	const options: ExportEncoding[] = [
		{ extension: "mp4", video: "avc", audio: "aac" },
		{ extension: "webm", video: "vp9", audio: "opus" },
		{ extension: "webm", video: "vp8", audio: "opus" },
	];
	for (const option of options) {
		if (
			(await canEncodeVideo(option.video, { width, height })) &&
			(!hasAudio ||
				(await canEncodeAudio(option.audio, { numberOfChannels: 2, sampleRate: SAMPLE_RATE })))
		)
			return option;
	}
	throw new Error(
		"이 브라우저에서 영상 인코딩을 지원하지 않습니다. 최신 데스크톱 Chrome 또는 Edge에서 열어 주세요.",
	);
}

type AudioSegment = {
	track: InputAudioTrack;
	start: number;
	trimStart: number;
	duration: number;
	volume: number;
	rate?: number;
};

function checkAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("내보내기를 취소했습니다.", "AbortError");
}

/** Map an audio packet to a bounded output block, including trims at both boundaries. */
export function audioPlacement(
	segment: Pick<AudioSegment, "start" | "trimStart" | "duration" | "rate">,
	packetStart: number,
	packetDuration: number,
	blockStart: number,
	blockDuration: number,
) {
	const rate = segment.rate ?? 1;
	const sourceStart = Math.max(
		packetStart,
		segment.trimStart,
		segment.trimStart + (blockStart - segment.start) * rate,
	);
	const sourceEnd = Math.min(
		packetStart + packetDuration,
		segment.trimStart + segment.duration * rate,
		segment.trimStart + (blockStart + blockDuration - segment.start) * rate,
	);
	if (sourceEnd <= sourceStart) return null;
	return {
		when: Math.max(0, segment.start + (sourceStart - segment.trimStart) / rate - blockStart),
		offset: Math.max(0, sourceStart - packetStart),
		duration: sourceEnd - sourceStart,
	};
}

async function mixAudioBlock(
	segments: AudioSegment[],
	start: number,
	duration: number,
	signal?: AbortSignal,
) {
	const context = new OfflineAudioContext(
		2,
		Math.max(1, Math.round(duration * SAMPLE_RATE)),
		SAMPLE_RATE,
	);
	for (const segment of segments) {
		checkAbort(signal);
		if (segment.start >= start + duration || segment.start + segment.duration <= start) continue;
		const rate = segment.rate ?? 1;
		const from = segment.trimStart + Math.max(0, start - segment.start) * rate;
		const to =
			segment.trimStart + Math.min(segment.duration, start + duration - segment.start) * rate;
		const sink = new AudioBufferSink(segment.track);
		for await (const packet of sink.buffers(from, to)) {
			checkAbort(signal);
			const placement = audioPlacement(segment, packet.timestamp, packet.duration, start, duration);
			if (!placement) continue;
			const source = context.createBufferSource();
			source.buffer = packet.buffer;
			source.playbackRate.value = rate;
			const gain = context.createGain();
			gain.gain.value = segment.volume;
			source.connect(gain).connect(context.destination);
			source.start(placement.when, placement.offset, placement.duration);
		}
	}
	return context.startRendering();
}

/** Browser-only deterministic export; no playback, Electron, native binaries, or uploads. */
export async function exportVideo(
	project: WebProject,
	assets: WebAsset[],
	options: ExportOptions = {},
): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
	const { signal, onProgress } = options;
	checkAbort(signal);
	const duration = getProjectDuration(project);
	if (!project.clips.length || !Number.isFinite(duration) || duration <= 0)
		throw new Error("내보낼 사진이나 영상을 타임라인에 추가해 주세요.");
	const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
	const inputs = new Map<string, Input>();
	let output: Output | undefined;
	const inputFor = (assetId: string) => {
		const asset = assetMap.get(assetId);
		if (!asset) throw new Error("원본 미디어가 없습니다. 프로젝트를 다시 가져와 주세요.");
		let input = inputs.get(assetId);
		if (!input) {
			input = new Input({ source: new BlobSource(asset.blob), formats: ALL_FORMATS });
			inputs.set(assetId, input);
		}
		return input;
	};
	try {
		onProgress?.(0);
		const audioSegments: AudioSegment[] = [];
		const addAudio = async (
			assetId: string,
			start: number,
			trimStart: number,
			length: number,
			volume: number,
			required = false,
			rate = 1,
		) => {
			if (volume <= 0 || start >= duration) return;
			const track = await inputFor(assetId).getPrimaryAudioTrack();
			if (!track) {
				if (required) throw new Error(`${assetMap.get(assetId)?.name}: 오디오 트랙이 없습니다.`);
				return;
			}
			if (!(await track.canDecode()))
				throw new Error(
					`${assetMap.get(assetId)?.name}: 오디오 코덱을 읽을 수 없습니다. WAV 또는 MP3로 변환해 주세요.`,
				);
			audioSegments.push({
				track,
				start,
				trimStart,
				duration: Math.min(length, duration - start),
				volume,
				rate,
			});
		};
		let timelineStart = 0;
		for (const clip of project.clips) {
			checkAbort(signal);
			const asset = assetMap.get(clip.assetId);
			if (!asset) throw new Error("클립의 원본 미디어를 찾을 수 없습니다.");
			if (asset.kind === "video") {
				for (const segment of getClipTiming(clip))
					await addAudio(
						asset.id,
						timelineStart + segment.outputStart,
						clip.trimStart + segment.sourceStart,
						segment.outputEnd - segment.outputStart,
						clip.volume,
						false,
						segment.rate,
					);
			}
			timelineStart += getClipOutputDuration(clip);
		}
		for (const audio of project.audio)
			await addAudio(
				audio.assetId,
				audio.start,
				audio.trimStart,
				audio.duration,
				audio.volume,
				true,
			);
		const encoding = await chooseExportEncoding(
			project.width,
			project.height,
			audioSegments.length > 0,
		);
		checkAbort(signal);
		const canvas = document.createElement("canvas");
		canvas.width = project.width;
		canvas.height = project.height;
		const context = canvas.getContext("2d", { alpha: false });
		if (!context) throw new Error("캔버스 렌더러를 시작할 수 없습니다.");
		const target = new BufferTarget();
		output = new Output({
			format:
				encoding.extension === "mp4"
					? new Mp4OutputFormat({ fastStart: "in-memory" })
					: new WebMOutputFormat(),
			target,
		});
		const videoSource = new CanvasSource(canvas, {
			codec: encoding.video,
			bitrate: Math.max(2_000_000, Math.round(project.width * project.height * 4)),
			keyFrameInterval: 2,
		});
		output.addVideoTrack(videoSource, { frameRate: FPS });
		const audioSource = audioSegments.length
			? new AudioBufferSource({ codec: encoding.audio, bitrate: 192_000 })
			: null;
		if (audioSource) output.addAudioTrack(audioSource);
		await output.start();
		const totalFrames = getProjectFrameCount(project);
		let frameIndex = 0;
		timelineStart = 0;
		for (const clip of project.clips) {
			checkAbort(signal);
			const asset = assetMap.get(clip.assetId);
			if (!asset) throw new Error("클립의 원본 미디어를 찾을 수 없습니다.");
			const endFrame = Math.min(
				totalFrames,
				Math.ceil((timelineStart + getClipOutputDuration(clip)) * FPS - 1e-7),
			);
			const startFrame = frameIndex;
			const writeFrame = async (source: CanvasImageSource) => {
				checkAbort(signal);
				const time = frameIndex / FPS;
				drawFrame(context, source, clip, project.width, project.height, time - timelineStart, {
					captions: project.captions,
					captionStyle: project.captionStyle,
					timelineTime: time,
				});
				await videoSource.add(time, Math.min(1 / FPS, duration - time));
				frameIndex++;
				onProgress?.((0.85 * frameIndex) / totalFrames);
			};
			if (asset.kind === "image") {
				const bitmap = await createImageBitmap(asset.blob);
				try {
					while (frameIndex < endFrame) await writeFrame(bitmap);
				} finally {
					bitmap.close();
				}
			} else {
				const track = await inputFor(asset.id).getPrimaryVideoTrack();
				if (!track || !(await track.canDecode()))
					throw new Error(`${asset.name}: 이 브라우저에서 영상 코덱을 읽을 수 없습니다.`);
				const firstTimestamp = await track.getFirstTimestamp();
				const sink = new CanvasSink(track, { poolSize: 2 });
				const clipStart = timelineStart;
				function* timestamps() {
					for (let index = startFrame; index < endFrame; index++)
						yield Math.max(
							firstTimestamp,
							clip.trimStart + clipOutputToSourceTime(clip, index / FPS - clipStart),
						);
				}
				for await (const frame of sink.canvasesAtTimestamps(timestamps())) {
					if (!frame)
						throw new Error(`${asset.name}: 선택한 구간의 영상 프레임을 읽을 수 없습니다.`);
					await writeFrame(frame.canvas);
				}
			}
			timelineStart += getClipOutputDuration(clip);
		}
		videoSource.close();
		if (audioSource) {
			// Bound raw PCM memory even for long projects; the encoder receives consecutive blocks.
			for (let start = 0; start < duration; start += AUDIO_BLOCK_SECONDS) {
				checkAbort(signal);
				const length = Math.min(AUDIO_BLOCK_SECONDS, duration - start);
				const buffer = await mixAudioBlock(audioSegments, start, length, signal);
				checkAbort(signal);
				await audioSource.add(buffer);
				onProgress?.(0.85 + (0.14 * (start + length)) / duration);
			}
			audioSource.close();
		}
		checkAbort(signal);
		await output.finalize();
		checkAbort(signal);
		if (!target.buffer) throw new Error("영상 파일을 만들지 못했습니다.");
		onProgress?.(1);
		return {
			blob: new Blob([target.buffer], { type: `video/${encoding.extension}` }),
			extension: encoding.extension,
		};
	} catch (error) {
		await output?.cancel().catch(() => undefined);
		throw error;
	} finally {
		for (const input of inputs.values()) input.dispose();
	}
}
