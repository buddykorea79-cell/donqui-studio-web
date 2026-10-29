import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	CanvasSink,
	EncodedPacketSink,
	Input,
} from "mediabunny";
import { exportVideo } from "/src/web/exportVideo.ts";
import { importMedia } from "/src/web/media.ts";
import { createAudio, createClip, createProject } from "/src/web/project.ts";
import { drawFrame } from "/src/web/renderFrame.ts";

const resultPanel = document.querySelector("#result");
const button = document.querySelector("#run");
const download = document.querySelector("#download");
const player = document.querySelector("#video");
let outputUrl;

function assert(value, message) {
	if (!value) throw new Error(message);
}

function makeCanvas(width, height) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function toneFile() {
	const rate = 48_000;
	const samples = rate * 2;
	const bytes = new ArrayBuffer(44 + samples * 2);
	const data = new DataView(bytes);
	const text = (offset, value) => {
		[...value].forEach((letter, index) => data.setUint8(offset + index, letter.charCodeAt(0)));
	};
	text(0, "RIFF");
	data.setUint32(4, 36 + samples * 2, true);
	text(8, "WAVE");
	text(12, "fmt ");
	data.setUint32(16, 16, true);
	data.setUint16(20, 1, true);
	data.setUint16(22, 1, true);
	data.setUint32(24, rate, true);
	data.setUint32(28, rate * 2, true);
	data.setUint16(32, 2, true);
	data.setUint16(34, 16, true);
	text(36, "data");
	data.setUint32(40, samples * 2, true);
	for (let index = 0; index < samples; index++) {
		data.setInt16(
			44 + index * 2,
			Math.sin((index / rate) * 440 * Math.PI * 2) * 0.25 * 32_767,
			true,
		);
	}
	return new File([bytes], "tone.wav", { type: "audio/wav" });
}

async function intervalRms(track, start, end) {
	let sumSquares = 0;
	let count = 0;
	for await (const packet of new AudioBufferSink(track).buffers(start, end)) {
		const samples = packet.buffer.getChannelData(0);
		const rate = packet.buffer.sampleRate;
		const from = Math.max(0, Math.ceil((start - packet.timestamp) * rate));
		const to = Math.min(samples.length, Math.ceil((end - packet.timestamp) * rate));
		for (let index = from; index < to; index++) {
			sumSquares += samples[index] * samples[index];
			count++;
		}
	}
	return count ? Math.sqrt(sumSquares / count) : 0;
}

button.onclick = async () => {
	button.disabled = true;
	download.hidden = true;
	const inputs = [];
	try {
		resultPanel.textContent = "Preparing local media…";
		const imageCanvas = makeCanvas(400, 225);
		const imageContext = imageCanvas.getContext("2d");
		imageContext.fillStyle = "#1a7f9a";
		imageContext.fillRect(0, 0, 400, 225);
		const imageBlob = await new Promise((resolve) => imageCanvas.toBlob(resolve, "image/png"));
		const photo = await importMedia(new File([imageBlob], "photo.png", { type: "image/png" }));
		const response = await fetch("/tests/fixtures/sample.webm");
		assert(response.ok, "Sample fixture could not be fetched");
		const movie = await importMedia(
			new File([await response.blob()], "sample.webm", { type: "video/webm" }),
		);
		assert(movie.duration >= 1.1, "Sample fixture is too short for this test");
		const audio = await importMedia(toneFile());
		const project = createProject();
		project.width = 640;
		project.height = 360;
		project.clips = [
			{ ...createClip(photo), duration: 1, caption: "Donqui 실제 인코딩 확인" },
			{ ...createClip(movie), trimStart: 0.1, duration: 1, volume: 0 },
		];
		project.audio = [
			{ ...createAudio(audio), start: 0.2, trimStart: 0.1, duration: 0.5, volume: 0.7 },
			{ ...createAudio(audio), start: 1.1, trimStart: 0.1, duration: 0.5, volume: 1 },
		];
		const exported = await exportVideo(project, [photo, movie, audio], {
			onProgress: (value) => {
				resultPanel.textContent = `Encoding ${Math.round(value * 100)}%`;
			},
		});
		const input = new Input({ source: new BlobSource(exported.blob), formats: ALL_FORMATS });
		inputs.push(input);
		const duration = await input.computeDuration();
		const track = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();
		assert(track, "Output video is missing");
		assert(audioTrack, "Output audio is missing");
		assert(track.displayWidth === 640 && track.displayHeight === 360, "Output dimensions differ");
		assert(Math.abs(duration - 2) < 0.1, `Duration differs: ${duration} vs 2 seconds`);

		const timestamps = [];
		for await (const packet of new EncodedPacketSink(track).packets())
			timestamps.push(packet.timestamp);
		timestamps.sort((left, right) => left - right);
		assert(timestamps.length === 60, `Expected 60 encoded frames, got ${timestamps.length}`);
		const maxFrameTimestampError = Math.max(
			...timestamps.map((time, index) => Math.abs(time - index / 30)),
		);
		assert(
			maxFrameTimestampError < 0.001,
			`Frame timestamps differ from 30 fps: ${maxFrameTimestampError}`,
		);

		const outputFrames = new CanvasSink(track);
		const photoFrame = await outputFrames.getCanvas(0.1);
		assert(photoFrame, "Output photo frame is missing");
		const photoContext = photoFrame.canvas.getContext("2d");
		const pixel = photoContext.getImageData(4, 4, 1, 1).data;
		assert(
			Math.abs(pixel[0] - 26) < 18 &&
				Math.abs(pixel[1] - 127) < 18 &&
				Math.abs(pixel[2] - 154) < 18,
			"Photo pixels did not survive export",
		);
		const captionPixels = photoContext.getImageData(32, 270, 576, 83).data;
		let captionWhitePixels = 0;
		let captionDarkPixels = 0;
		for (let index = 0; index < captionPixels.length; index += 4) {
			const [red, green, blue] = captionPixels.subarray(index, index + 3);
			if (red > 200 && green > 200 && blue > 200) captionWhitePixels++;
			if (red < 18 && green < 70 && blue < 90) captionDarkPixels++;
		}
		assert(captionWhitePixels > 20, "Caption text pixels are missing");
		assert(captionDarkPixels > 100, "Caption background pixels are missing");

		const movieInput = new Input({ source: new BlobSource(movie.blob), formats: ALL_FORMATS });
		inputs.push(movieInput);
		const sourceTrack = await movieInput.getPrimaryVideoTrack();
		const movieFrame = await outputFrames.getCanvas(1.25);
		assert(movieFrame && sourceTrack, "Video segment or source frame is missing");
		const localTime = movieFrame.timestamp - 1;
		const sourceFrame = await new CanvasSink(sourceTrack).getCanvas(
			project.clips[1].trimStart + localTime,
		);
		assert(sourceFrame, "Trimmed source frame is missing");
		const reference = makeCanvas(640, 360);
		drawFrame(
			reference.getContext("2d"),
			sourceFrame.canvas,
			project.clips[1],
			640,
			360,
			localTime,
		);
		const expectedPixels = reference.getContext("2d").getImageData(0, 0, 640, 360).data;
		const actualPixels = movieFrame.canvas.getContext("2d").getImageData(0, 0, 640, 360).data;
		let difference = 0;
		let samples = 0;
		for (let y = 8; y < 360; y += 16) {
			for (let x = 8; x < 640; x += 16) {
				for (let channel = 0; channel < 3; channel++) {
					const index = (y * 640 + x) * 4 + channel;
					difference += Math.abs(expectedPixels[index] - actualPixels[index]);
					samples++;
				}
			}
		}
		const videoMeanPixelError = difference / samples;
		assert(
			videoMeanPixelError < 18,
			`Video segment differs from its trimmed source: ${videoMeanPixelError}`,
		);

		const silentRms = await intervalRms(audioTrack, 0.02, 0.1);
		const reducedRms = await intervalRms(audioTrack, 0.3, 0.6);
		const unityRms = await intervalRms(audioTrack, 1.2, 1.5);
		const afterRms = await intervalRms(audioTrack, 1.8, 1.9);
		const gainRatio = reducedRms / unityRms;
		assert(silentRms < 0.003 && afterRms < 0.003, "Audio exceeds its selected timeline interval");
		assert(unityRms > 0.05, "Reference tone is missing or inaudible");
		assert(Math.abs(gainRatio - 0.7) < 0.05, `Applied gain differs from 0.7: ${gainRatio}`);

		if (outputUrl) URL.revokeObjectURL(outputUrl);
		outputUrl = URL.createObjectURL(exported.blob);
		download.href = outputUrl;
		download.download = `donqui-smoke.${exported.extension}`;
		download.hidden = false;
		player.src = outputUrl;
		resultPanel.textContent = JSON.stringify(
			{
				status: "PASS",
				format: exported.extension,
				bytes: exported.blob.size,
				width: track.displayWidth,
				height: track.displayHeight,
				duration,
				frameCount: timestamps.length,
				maxFrameTimestampError,
				photoPixel: [...pixel],
				captionWhitePixels,
				captionDarkPixels,
				videoMeanPixelError,
				silentRms,
				reducedRms,
				unityRms,
				gainRatio,
				afterRms,
				checks: [
					"PNG/WAV/video import",
					"decoded 640×360 output",
					"60 frame timestamps at 30 fps",
					"photo pixels",
					"caption text and background pixels",
					"video segment matches trimmed source",
					"silence outside audio intervals",
					"measured 0.7 audio gain ratio",
				],
			},
			null,
			2,
		);
	} catch (error) {
		resultPanel.textContent = `FAIL: ${error.stack ?? error}`;
	} finally {
		for (const input of inputs) input.dispose();
		button.disabled = false;
	}
};
