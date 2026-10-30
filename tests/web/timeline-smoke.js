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
import {
	applyTimelineRegion,
	deleteTimelineRange,
	resizeClipEdge,
} from "/src/web/timelineEditing.ts";

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

// Hand-calculated after the editing scenario below. No production timing/zoom helpers
// are used for these expectations, so an incorrect edit cannot validate itself.
function expectedEditedSourceTime(time) {
	if (time < 0.6) return 0.9 + time;
	if (time < 1.6) return 1.5 + (time - 0.6) * 2;
	if (time < 3.6) return 3.5 + (time - 1.6) * 0.5;
	if (time < 4) return 4.5 + time - 3.6;
	if (time < 4.2) return 4.9 + (time - 4) * 2;
	return 0; // The final image is the source's still frame at zero.
}

function expectedEditedZoom(time) {
	const region = [
		{ start: 0.1, end: 1.35, ramp: 0.25, focusX: 0.65, focusY: 0.4 },
		{ start: 3.6, end: 4.2, ramp: 0.25, focusX: 0.5, focusY: 0.5 },
		{ start: 4.2, end: 4.4, ramp: 0.1, focusX: 0.5, focusY: 0.5 },
	].find(({ start, end }) => time >= start && time < end);
	if (!region) return { scale: 1, focusX: 0.5, focusY: 0.5 };
	const phase = Math.max(
		0,
		Math.min(1, (time - region.start) / region.ramp, (region.end - time) / region.ramp),
	);
	const scale = 1 + phase * phase * (3 - 2 * phase);
	return {
		scale,
		focusX: Math.max(0.5 / scale, Math.min(1 - 0.5 / scale, region.focusX)),
		focusY: Math.max(0.5 / scale, Math.min(1 - 0.5 / scale, region.focusY)),
	};
}

function cameraReference(source, { scale, focusX, focusY }) {
	const canvas = makeCanvas();
	const context = canvas.getContext("2d");
	context.translate(WIDTH / 2 - focusX * WIDTH * scale, HEIGHT / 2 - focusY * HEIGHT * scale);
	context.scale(scale, scale);
	context.drawImage(source, 0, 0, WIDTH, HEIGHT);
	return canvas;
}

function editedMarkerError(canvas, sourceTime, zoom) {
	const centerX = WIDTH / 2 + (170 + sourceTime * 52 - zoom.focusX * WIDTH) * zoom.scale;
	const centerY = HEIGHT / 2 + (210 - zoom.focusY * HEIGHT) * zoom.scale;
	const row = canvas.getContext("2d").getImageData(0, Math.round(centerY), WIDTH, 1).data;
	const columns = [];
	for (let x = 0; x < WIDTH; x++)
		if (row[x * 4] > 225 && row[x * 4 + 1] > 225 && row[x * 4 + 2] > 225) columns.push(x);
	assert(columns.length > 20, `Edited source marker is absent at source ${sourceTime}`);
	const expectedCenter =
		(Math.max(0, centerX - 15 * zoom.scale) + Math.min(WIDTH, centerX + 15 * zoom.scale)) / 2 - 0.5;
	return Math.abs((columns[0] + columns.at(-1)) / 2 - expectedCenter);
}

function captionPixelBounds(canvas) {
	const data = pixels(canvas);
	let count = 0;
	let minY = HEIGHT;
	let maxY = -1;
	for (let index = 0; index < data.length; index += 4) {
		// Only the yellow subtitle glyphs have this color in the generated fixture.
		if (data[index] > 170 && data[index + 1] > 160 && data[index + 2] < 140) {
			const y = Math.floor(index / 4 / WIDTH);
			count++;
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return { count, minY, maxY };
}

function stableProjectJson(project) {
	return JSON.stringify(project, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
				)
			: value,
	);
}

async function checkEditedExport(workspace, bitmap, sourceSink, inputs) {
	const { project, assets } = workspace;
	const movie = assets.find((asset) => asset.id === project.clips[0].assetId);
	assert(movie, "Edited fixture video asset is missing");
	const trimmed = resizeClipEdge(
		resizeClipEdge(project.clips[0], movie, "start", 0.4),
		movie,
		"end",
		-0.6,
	);
	assert(
		Math.abs(trimmed.trimStart - 0.9) < 1e-9 && Math.abs(trimmed.duration - 5) < 1e-9,
		"Edge trimming did not keep source 0.9–5.9",
	);
	let edited = { ...project, clips: [trimmed, project.clips[1]] };
	assert(Math.abs(getProjectDuration(edited) - 5.8) < 1e-9, "Wrong duration after trimming");
	// The video now occupies 0–5; cutting 4.4–5.2 removes its tail and the image's head.
	edited = deleteTimelineRange(edited, { start: 4.4, end: 5.2 }, assets);
	assert(
		edited.clips.length === 2 &&
			Math.abs(edited.clips[0].duration - 4.4) < 1e-9 &&
			Math.abs(edited.clips[1].duration - 0.6) < 1e-9 &&
			edited.clips[1].trimStart === 0 &&
			Math.abs(getProjectDuration(edited) - 5) < 1e-9,
		"Cross-clip deletion kept the wrong source fragments",
	);
	// Select against the original 5-second layout: 0.4 s in each clip becomes 0.2 s.
	const speed = applyTimelineRegion(edited, "speed", { start: 4, end: 4.8 });
	const zoom = applyTimelineRegion(speed.project, "zoom", { start: 3.6, end: 4.4 });
	edited = zoom.project;
	assert(
		speed.selection && zoom.selection,
		"Applying selected regions did not select a new effect",
	);
	assert(Math.abs(getProjectDuration(edited) - 4.6) < 1e-9, "Edited duration differs from 4.6 s");
	assert(getProjectFrameCount(edited) === 138, "Edited frame count differs from 138");
	assert(
		JSON.stringify(edited.captions) === JSON.stringify(project.captions) &&
			JSON.stringify(edited.audio) === JSON.stringify(project.audio),
		"Visual edits moved absolute-time captions or background audio",
	);
	const backup = encodeWorkspace({ project: edited, assets });
	const restored = await decodeWorkspace(backup);
	assert(
		stableProjectJson(restored.project) === stableProjectJson(edited),
		"Edited project effects did not survive a backup round trip",
	);
	attachBlob("#edited-backup", backup, "donqui-edited-timeline-qa.donqui");
	const exported = await exportVideo(edited, assets, {
		onProgress: (value) => {
			resultPanel.textContent = `Encoding trimmed/cut/selected timeline: ${Math.round(value * 100)}%`;
		},
	});
	attachBlob("#edited-download", exported.blob, `donqui-edited-timeline-qa.${exported.extension}`);
	const input = new Input({ source: new BlobSource(exported.blob), formats: ALL_FORMATS });
	inputs.push(input);
	const track = await input.getPrimaryVideoTrack();
	assert(track, "Edited output video track is missing");
	const duration = await input.computeDuration();
	assert(Math.abs(duration - 4.6) < 0.08, `Edited output duration is ${duration}, expected 4.6`);
	const timestamps = [];
	for await (const packet of new EncodedPacketSink(track).packets())
		timestamps.push(packet.timestamp);
	timestamps.sort((left, right) => left - right);
	assert(timestamps.length === 138, `Edited export has ${timestamps.length} frames, expected 138`);
	const timestampError = Math.max(...timestamps.map((time, index) => Math.abs(time - index / FPS)));
	assert(timestampError < 0.001, `Edited frame timestamps are irregular: ${timestampError}`);
	const sink = new CanvasSink(track);
	const summary = { duration, frames: timestamps.length, timestampError, samples: [], audio: [] };
	for (const time of [
		0, 0.4, 0.6, 0.9, 1.2, 1.4, 1.8, 2.3, 3.2, 3.6, 3.9, 4.1, 4.2, 4.3, 4.4, 4.5,
	]) {
		const frame = await sink.getCanvas(time + 0.00001);
		assert(frame, `Edited output frame is missing at ${time}`);
		const outputTime = Math.round(frame.timestamp * FPS) / FPS;
		assert(Math.abs(outputTime - time) < 0.001, `Wrong edited frame selected at ${time}`);
		const sourceTime = expectedEditedSourceTime(outputTime);
		const image = outputTime >= 4.2;
		const source = image ? bitmap : (await sourceSink.getCanvas(sourceTime + 0.00001))?.canvas;
		assert(source, `Edited source frame is missing at ${sourceTime}`);
		const camera = expectedEditedZoom(outputTime);
		const expected = reference(
			edited,
			cameraReference(source, camera),
			{ ...edited.clips[image ? 1 : 0], effect: "none", zoomRegions: [], speedRegions: [] },
			0,
			outputTime,
		);
		const previewError = difference(pixels(frame.canvas), pixels(expected));
		assert(
			previewError < 8,
			`Edited camera/source/caption pixels differ at ${time}: ${previewError}`,
		);
		// The original off-center zoom covers the marker with the subtitle; other
		// frames independently verify the marker's projected position and the cut to the image.
		const markerError =
			time >= 0.1 && time < 1.35 ? null : editedMarkerError(frame.canvas, sourceTime, camera);
		assert(
			markerError === null || markerError < 4,
			`Edited marker is misplaced at ${time}: ${markerError}`,
		);
		const caption = captionPixelBounds(frame.canvas);
		const captionVisible = (time >= 0.6 && time < 1.6) || (time >= 2.2 && time < 3.8) || image;
		assert(
			captionVisible
				? caption.count > 25 && caption.minY > 275 && caption.maxY < 335
				: caption.count < 10,
			`Edited caption visibility/position differs at ${time}: ${JSON.stringify(caption)}`,
		);
		summary.samples.push({
			outputTime,
			sourceTime,
			image,
			scale: camera.scale,
			previewError,
			markerError,
			caption,
		});
	}
	const audio = await input.getPrimaryAudioTrack();
	assert(audio, "Edited audio track is missing");
	for (const [start, end, frequency] of [
		[0.2, 0.4, 440],
		[0.8, 1.2, 880],
		[1.8, 2, 220],
		[4.05, 4.15, 880],
	]) {
		const amplitude = frequencyAmplitude(await audioSamples(audio, start, end), frequency);
		assert(amplitude > 0.07, `Edited ${frequency} Hz audio is absent at ${start}: ${amplitude}`);
		summary.audio.push({ start, end, frequency, amplitude });
	}
	const silent = await audioSamples(audio, 4.3, 4.5);
	summary.silenceRms = Math.sqrt(
		silent.reduce((sum, value) => sum + value * value, 0) / silent.length,
	);
	assert(summary.silenceRms < 0.003, "Edited video audio leaks past the new image boundary");
	return summary;
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
	for (const id of ["#download", "#backup", "#edited-download", "#edited-backup"])
		document.querySelector(id).hidden = true;
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
		report.editing = await checkEditedExport(workspace, bitmap, sourceSink, inputs);
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
