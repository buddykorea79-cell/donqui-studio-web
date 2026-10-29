import {
	ALL_FORMATS,
	AudioBufferSink,
	AudioBufferSource,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	EncodedPacketSink,
	Input,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import { decodeWorkspace, encodeWorkspace } from "/src/web/archive.ts";
import { parseSrt } from "/src/web/captions.ts";
import { chooseExportEncoding, exportVideo } from "/src/web/exportVideo.ts";
import { importMedia } from "/src/web/media.ts";
import {
	createAudio,
	createClip,
	createProject,
	getProjectDuration,
	getProjectFrameCount,
} from "/src/web/project.ts";
import { drawFrame } from "/src/web/renderFrame.ts";

const resultPanel = document.querySelector("#result");
const button = document.querySelector("#run");
const urls = [];
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const SAMPLE_RATE = 48_000;

function assert(value, message) {
	if (!value) throw new Error(message);
}

function makeCanvas() {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	return canvas;
}

function drawSource(context, time) {
	context.fillStyle = "#123d69";
	context.fillRect(0, 0, WIDTH, HEIGHT);
	context.fillStyle = "#e58824";
	context.fillRect(10, 40, 130, 260);
	context.fillStyle = "#38c985";
	context.fillRect(335, 40, 200, 150);
	context.fillStyle = "#213044";
	context.fillRect(250, 235, 325, 80);
	context.fillStyle = "#ffffff";
	context.fillRect(155 + time * 52, 195, 30, 30);
	context.font = "bold 32px system-ui";
	context.fillText(`SOURCE ${time.toFixed(2)}`, 245, 290);
	context.fillStyle = "#ff4ab9";
	context.beginPath();
	context.arc(440, 102, 15, 0, Math.PI * 2);
	context.fill();
}

function toneBuffer(duration, frequency, amplitude) {
	const buffer = new AudioBuffer({
		numberOfChannels: 1,
		length: Math.round(duration * SAMPLE_RATE),
		sampleRate: SAMPLE_RATE,
	});
	const samples = buffer.getChannelData(0);
	for (let index = 0; index < samples.length; index++)
		samples[index] = amplitude * Math.sin((index / SAMPLE_RATE) * frequency * Math.PI * 2);
	return buffer;
}

function waveFile(buffer) {
	const samples = buffer.getChannelData(0);
	const bytes = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(bytes);
	const word = (offset, text) => {
		[...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
	};
	word(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	word(8, "WAVE");
	word(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	word(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let index = 0; index < samples.length; index++)
		view.setInt16(44 + index * 2, samples[index] * 32_767, true);
	return new File([bytes], "background-660hz.wav", { type: "audio/wav" });
}

async function createSourceVideo() {
	const canvas = makeCanvas();
	const context = canvas.getContext("2d");
	const encoding = await chooseExportEncoding(WIDTH, HEIGHT, true);
	const target = new BufferTarget();
	const output = new Output({
		format: encoding.extension === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
		target,
	});
	const video = new CanvasSource(canvas, { codec: encoding.video, bitrate: 3_000_000 });
	const audio = new AudioBufferSource({ codec: encoding.audio, bitrate: 192_000 });
	output.addVideoTrack(video, { frameRate: FPS });
	output.addAudioTrack(audio);
	await output.start();
	for (let frame = 0; frame < 195; frame++) {
		drawSource(context, frame / FPS);
		await video.add(frame / FPS, 1 / FPS);
	}
	video.close();
	await audio.add(toneBuffer(6.5, 440, 0.2));
	audio.close();
	await output.finalize();
	return new File([target.buffer], `timeline-source.${encoding.extension}`, {
		type: `video/${encoding.extension}`,
	});
}

function pixels(canvas) {
	return canvas.getContext("2d").getImageData(0, 0, WIDTH, HEIGHT).data;
}

function difference(left, right) {
	let total = 0;
	for (let index = 0; index < left.length; index += 4)
		for (let channel = 0; channel < 3; channel++)
			total += Math.abs(left[index + channel] - right[index + channel]);
	return total / ((left.length / 4) * 3);
}

function reference(project, source, clip, localTime, timelineTime) {
	const canvas = makeCanvas();
	drawFrame(canvas.getContext("2d"), source, clip, WIDTH, HEIGHT, localTime, {
		captions: project.captions,
		captionStyle: project.captionStyle,
		timelineTime,
	});
	return canvas;
}

// Independent expectation: do not call the production source-time mapping here.
function expectedSourceTime(outputTime) {
	if (outputTime < 1) return 0.5 + outputTime;
	if (outputTime < 2) return 1.5 + (outputTime - 1) * 2;
	if (outputTime < 4) return 3.5 + (outputTime - 2) * 0.5;
	return 4.5 + outputTime - 4;
}

function attachBlob(id, blob, name) {
	const url = URL.createObjectURL(blob);
	urls.push(url);
	const anchor = document.querySelector(id);
	anchor.href = url;
	anchor.download = name;
	anchor.hidden = false;
	return url;
}

async function audioSamples(track, start, end) {
	const samples = new Float32Array(Math.round((end - start) * SAMPLE_RATE));
	for await (const packet of new AudioBufferSink(track).buffers(start, end)) {
		const data = packet.buffer.getChannelData(0);
		const sampleRate = packet.buffer.sampleRate;
		assert(sampleRate === SAMPLE_RATE, "Decoded output sample rate is not 48 kHz");
		for (let index = 0; index < data.length; index++) {
			const destination = Math.round((packet.timestamp - start) * SAMPLE_RATE) + index;
			if (destination >= 0 && destination < samples.length) samples[destination] = data[index];
		}
	}
	return samples;
}

function frequencyAmplitude(samples, frequency) {
	let real = 0;
	let imaginary = 0;
	for (let index = 0; index < samples.length; index++) {
		const phase = (index / SAMPLE_RATE) * frequency * Math.PI * 2;
		real += samples[index] * Math.cos(phase);
		imaginary += samples[index] * Math.sin(phase);
	}
	return (2 * Math.hypot(real, imaginary)) / samples.length;
}

button.onclick = async () => {
	button.disabled = true;
	resultPanel.dataset.status = "RUNNING";
	for (const url of urls) URL.revokeObjectURL(url);
	urls.length = 0;
	for (const id of ["#download", "#backup"]) document.querySelector(id).hidden = true;
	const inputs = [];
	let bitmap;
	const report = {};
	try {
		resultPanel.textContent = "Generating moving source video with a 440 Hz tone…";
		const movie = await importMedia(await createSourceVideo());
		const audio = await importMedia(waveFile(toneBuffer(2, 660, 0.2)));
		const photoCanvas = makeCanvas();
		drawSource(photoCanvas.getContext("2d"), 0);
		const photoBlob = await new Promise((resolve) => photoCanvas.toBlob(resolve, "image/png"));
		assert(photoBlob, "Could not create the still frame");
		bitmap = await createImageBitmap(photoBlob);
		const photo = await importMedia(
			new File([photoBlob], "timeline-end.png", { type: "image/png" }),
		);
		const clip = {
			...createClip(movie),
			trimStart: 0.5,
			duration: 6,
			volume: 0.7,
			speedRegions: [
				{ id: "fast", start: 1, end: 3, rate: 2 },
				{ id: "slow", start: 3, end: 4, rate: 0.5 },
			],
			zoomRegions: [{ id: "zoom", start: 0.5, end: 2.5, scale: 2, focusX: 0.65, focusY: 0.4 }],
		};
		const project = {
			...createProject(),
			title: "돋보기와 배속 웹 검사",
			width: WIDTH,
			height: HEIGHT,
			clips: [clip, { ...createClip(photo), duration: 0.8, caption: "마지막 사진 자막" }],
			audio: [{ ...createAudio(audio), start: 2.6, trimStart: 0.2, duration: 1, volume: 0.5 }],
			captions: parseSrt(
				"1\n00:00:00,600 --> 00:00:01,600\n확대와 빠르게\n\n2\n00:00:02,200 --> 00:00:03,800\n느리게 재생해도 자막 시간 유지\n",
			),
			captionStyle: { fontSize: 0.055, color: "#ffee44", position: "bottom", background: true },
		};
		const workspace = { project, assets: [movie, audio, photo] };
		const backup = encodeWorkspace(workspace);
		const restored = await decodeWorkspace(backup);
		assert(
			JSON.stringify(restored.project.clips[0].zoomRegions) === JSON.stringify(clip.zoomRegions) &&
				JSON.stringify(restored.project.clips[0].speedRegions) ===
					JSON.stringify(clip.speedRegions) &&
				getProjectDuration(restored.project) === getProjectDuration(project) &&
				restored.assets.length === workspace.assets.length,
			"Backup changed the timeline data",
		);
		attachBlob("#backup", backup, "donqui-timeline-qa.donqui");
		assert(
			Math.abs(getProjectDuration(project) - 6.8) < 1e-9,
			"Mapped project duration differs from 6.8 seconds",
		);
		assert(getProjectFrameCount(project) === 204, "Mapped output frame count differs from 204");
		const exported = await exportVideo(project, workspace.assets, {
			onProgress: (value) => {
				resultPanel.textContent = `Encoding timeline effects: ${Math.round(value * 100)}%`;
			},
		});
		document.querySelector("#video").src = attachBlob(
			"#download",
			exported.blob,
			`donqui-timeline-qa.${exported.extension}`,
		);
		const outputInput = new Input({ source: new BlobSource(exported.blob), formats: ALL_FORMATS });
		const sourceInput = new Input({ source: new BlobSource(movie.blob), formats: ALL_FORMATS });
		inputs.push(outputInput, sourceInput);
		const outputTrack = await outputInput.getPrimaryVideoTrack();
		const sourceTrack = await sourceInput.getPrimaryVideoTrack();
		assert(outputTrack && sourceTrack, "Expected video tracks are missing");
		assert(
			outputTrack.displayWidth === WIDTH && outputTrack.displayHeight === HEIGHT,
			"Output dimensions changed",
		);
		const duration = await outputInput.computeDuration();
		assert(Math.abs(duration - 6.8) < 0.08, `Output duration is ${duration}, expected 6.8`);
		const timestamps = [];
		for await (const packet of new EncodedPacketSink(outputTrack).packets())
			timestamps.push(packet.timestamp);
		timestamps.sort((left, right) => left - right);
		assert(timestamps.length === 204, `Expected 204 encoded frames, got ${timestamps.length}`);
		const timestampError = Math.max(
			...timestamps.map((time, index) => Math.abs(time - index / FPS)),
		);
		assert(timestampError < 0.001, `Output frame timestamps are irregular: ${timestampError}`);
		report.output = {
			format: exported.extension,
			bytes: exported.blob.size,
			duration,
			frames: timestamps.length,
			timestampError,
		};
		const outputSink = new CanvasSink(outputTrack);
		const sourceSink = new CanvasSink(sourceTrack);
		resultPanel.textContent = "Checking source-time mapping, zoom and caption pixels…";
		report.frames = [];
		for (const time of [0.2, 0.6, 0.9, 1.2, 1.4, 1.8, 2.3, 3.2, 4.5, 5.8]) {
			const frame = await outputSink.getCanvas(time + 0.00001);
			assert(frame, `Missing output frame at ${time}`);
			const sourceTime = expectedSourceTime(frame.timestamp);
			const sourceFrame = await sourceSink.getCanvas(sourceTime + 0.00001);
			assert(sourceFrame, `Missing source frame at ${sourceTime}`);
			const expected = reference(
				project,
				sourceFrame.canvas,
				clip,
				frame.timestamp,
				frame.timestamp,
			);
			const actualPixels = pixels(frame.canvas);
			const previewError = difference(actualPixels, pixels(expected));
			assert(previewError < 8, `Source/zoom preview mismatch at ${time}: ${previewError}`);
			const bare = reference(
				project,
				sourceFrame.canvas,
				{ ...clip, zoomRegions: [] },
				frame.timestamp,
				frame.timestamp,
			);
			const zoomDifference = difference(actualPixels, pixels(bare));
			if (time === 0.9 || time === 1.2 || time === 1.4)
				assert(zoomDifference > 8, `Zoom has no visible effect at ${time}: ${zoomDifference}`);
			if (time === 0.2 || time === 1.8 || time > 2)
				assert(zoomDifference < 8, `Zoom leaks beyond its interval at ${time}: ${zoomDifference}`);
			// A small moving marker can pass a whole-frame mean comparison, so also
			// measure its expected position without using the production time mapper.
			let markerError = null;
			if (time === 0.2 || time === 1.8 || time > 2) {
				const row = frame.canvas.getContext("2d").getImageData(0, 210, WIDTH, 1).data;
				const whiteColumns = [];
				for (let x = 0; x < WIDTH; x++)
					if (row[x * 4] > 225 && row[x * 4 + 1] > 225 && row[x * 4 + 2] > 225)
						whiteColumns.push(x);
				assert(whiteColumns.length > 20, `Moving source marker is absent at ${time}`);
				const center = (whiteColumns[0] + whiteColumns.at(-1)) / 2;
				markerError = Math.abs(center - (170 + sourceTime * 52));
				assert(markerError < 3, `Wrong source frame position at ${time}: ${markerError} px`);
			}
			if (time === 0.9 || time === 1.2) {
				const center = frame.canvas.getContext("2d").getImageData(320, 180, 1, 1).data;
				assert(
					center[0] < 100 && center[1] > 150 && center[2] > 80 && center[2] < 170,
					`Zoom focus is not centered on the green landmark at ${time}`,
				);
			}
			const noCaptions = reference(
				{ ...project, captions: [] },
				sourceFrame.canvas,
				clip,
				frame.timestamp,
				frame.timestamp,
			);
			const captionDifference = difference(actualPixels, pixels(noCaptions));
			const captionVisible = (time >= 0.6 && time < 1.6) || (time >= 2.2 && time < 3.8);
			assert(
				captionVisible ? captionDifference > 1.5 : captionDifference < 8,
				`Caption visibility differs at ${time}`,
			);
			report.frames.push({
				outputTime: frame.timestamp,
				sourceTime,
				previewError,
				zoomDifference,
				markerError,
				captionDifference,
			});
		}
		const finalFrame = await outputSink.getCanvas(6.4);
		const finalExpected = reference(
			project,
			bitmap,
			project.clips[1],
			finalFrame.timestamp - 6,
			finalFrame.timestamp,
		);
		report.nextClipError = difference(pixels(finalFrame.canvas), pixels(finalExpected));
		assert(report.nextClipError < 8, "The next clip starts at the wrong mapped output time");
		const outputAudio = await outputInput.getPrimaryAudioTrack();
		assert(outputAudio, "Exported audio track is missing");
		resultPanel.textContent = "Checking sped-up, slowed-down and unchanged background audio…";
		report.audio = [];
		for (const [start, end, frequency] of [
			[0.2, 0.4, 440],
			[1.2, 1.6, 880],
			[2.2, 2.4, 220],
			[4.2, 4.6, 440],
		]) {
			const samples = await audioSamples(outputAudio, start, end);
			const amplitude = frequencyAmplitude(samples, frequency);
			const unwanted = frequencyAmplitude(samples, frequency === 440 ? 880 : 440);
			assert(
				amplitude > 0.07,
				`Expected ${frequency} Hz clip audio is absent at ${start}: ${amplitude}`,
			);
			assert(unwanted < amplitude * 0.15, `Wrong clip playback rate at ${start}: ${unwanted}`);
			report.audio.push({ start, end, frequency, amplitude, unwanted });
		}
		const mixed = await audioSamples(outputAudio, 2.8, 3.2);
		const backgroundAmplitude = frequencyAmplitude(mixed, 660);
		const incorrectlySlowedBackground = frequencyAmplitude(mixed, 330);
		const slowedClipAmplitude = frequencyAmplitude(mixed, 220);
		assert(
			backgroundAmplitude > 0.05 && slowedClipAmplitude > 0.07,
			"Background and slowed clip audio were not mixed",
		);
		assert(
			incorrectlySlowedBackground < backgroundAmplitude * 0.15,
			"Background music was slowed with the clip",
		);
		const silence = await audioSamples(outputAudio, 6.2, 6.6);
		const silenceRms = Math.sqrt(
			silence.reduce((sum, sample) => sum + sample * sample, 0) / silence.length,
		);
		assert(silenceRms < 0.003, `Clip audio leaks into the next still image: ${silenceRms}`);
		report.background = {
			backgroundAmplitude,
			slowedClipAmplitude,
			incorrectlySlowedBackground,
			silenceRms,
		};
		report.backupBytes = backup.size;
		resultPanel.dataset.status = "PASS";
		resultPanel.textContent = JSON.stringify({ status: "PASS", ...report }, null, 2);
	} catch (error) {
		resultPanel.dataset.status = "FAIL";
		resultPanel.textContent = JSON.stringify(
			{ status: "FAIL", error: error.stack ?? String(error), ...report },
			null,
			2,
		);
	} finally {
		bitmap?.close();
		for (const input of inputs) input.dispose();
		button.disabled = false;
	}
};
