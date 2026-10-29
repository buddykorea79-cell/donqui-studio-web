import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	CanvasSink,
	EncodedPacketSink,
	Input,
} from "mediabunny";
import { CLIP_EFFECTS } from "/src/lib/clip-effects/catalog.ts";
import { parseSrt, stringifySrt } from "/src/web/captions.ts";
import { exportVideo } from "/src/web/exportVideo.ts";
import { importMedia } from "/src/web/media.ts";
import { createAudio, createClip, createProject } from "/src/web/project.ts";
import { drawFrame } from "/src/web/renderFrame.ts";

const resultPanel = document.querySelector("#result");
const button = document.querySelector("#run");
const urls = [];

function assert(value, message) {
	if (!value) throw new Error(message);
}

function makeCanvas(width, height) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function pixels(canvas) {
	return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

function meanDifference(left, right) {
	assert(left.length === right.length, "Compared frames have different dimensions");
	let total = 0;
	for (let index = 0; index < left.length; index += 4) {
		for (let channel = 0; channel < 3; channel++)
			total += Math.abs(left[index + channel] - right[index + channel]);
	}
	return total / ((left.length / 4) * 3);
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
			Math.sin((index / rate) * 440 * Math.PI * 2) * 0.2 * 32_767,
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

function frameReference(project, source, clip, localTime, timelineTime, options = {}) {
	const canvas = makeCanvas(project.width, project.height);
	drawFrame(canvas.getContext("2d"), source, clip, project.width, project.height, localTime, {
		captions: project.captions,
		captionStyle: project.captionStyle,
		timelineTime,
		...options,
	});
	return canvas;
}

function attachResult(exported, anchorId, videoId) {
	const url = URL.createObjectURL(exported.blob);
	urls.push(url);
	const anchor = document.querySelector(anchorId);
	anchor.href = url;
	anchor.download = `donqui-effects-${videoId.slice(1)}.${exported.extension}`;
	anchor.hidden = false;
	document.querySelector(videoId).src = url;
}

async function decodeOutput(exported, project, inputs) {
	const input = new Input({ source: new BlobSource(exported.blob), formats: ALL_FORMATS });
	inputs.push(input);
	const duration = await input.computeDuration();
	const track = await input.getPrimaryVideoTrack();
	assert(track, "Output video track is missing");
	assert(
		track.displayWidth === project.width && track.displayHeight === project.height,
		"Output dimensions differ from the project",
	);
	const expectedDuration = project.clips.reduce((sum, clip) => sum + clip.duration, 0);
	assert(Math.abs(duration - expectedDuration) < 0.1, `Output duration differs: ${duration}`);
	const timestamps = [];
	for await (const packet of new EncodedPacketSink(track).packets())
		timestamps.push(packet.timestamp);
	timestamps.sort((left, right) => left - right);
	const expectedFrames = Math.round(expectedDuration * 30);
	assert(timestamps.length === expectedFrames, `Expected ${expectedFrames} encoded frames`);
	const timestampError = Math.max(...timestamps.map((time, index) => Math.abs(time - index / 30)));
	assert(timestampError < 0.001, `Frame timestamps differ from 30 fps: ${timestampError}`);
	return {
		input,
		track,
		sink: new CanvasSink(track),
		metrics: {
			format: exported.extension,
			bytes: exported.blob.size,
			width: track.displayWidth,
			height: track.displayHeight,
			duration,
			frameCount: timestamps.length,
			timestampError,
		},
	};
}

button.onclick = async () => {
	button.disabled = true;
	resultPanel.dataset.status = "RUNNING";
	for (const url of urls) URL.revokeObjectURL(url);
	urls.length = 0;
	for (const id of ["#download", "#download-portrait"]) document.querySelector(id).hidden = true;
	const inputs = [];
	let bitmap;
	const report = {};
	try {
		resultPanel.textContent = "Preparing asymmetric photo, source video and audio…";
		const imageCanvas = makeCanvas(480, 360);
		const context = imageCanvas.getContext("2d");
		context.fillStyle = "#1a7f9a";
		context.fillRect(0, 0, 480, 360);
		context.fillStyle = "#eb8c24";
		context.fillRect(25, 42, 130, 240);
		context.fillStyle = "#42c883";
		context.fillRect(225, 15, 210, 95);
		context.fillStyle = "#20304e";
		context.beginPath();
		context.arc(350, 250, 77, 0, 2 * Math.PI);
		context.fill();
		context.fillStyle = "#ffffff";
		context.font = "bold 40px system-ui";
		context.fillText("L  1 → 2", 30, 335);
		const imageBlob = await new Promise((resolve) => imageCanvas.toBlob(resolve, "image/png"));
		assert(imageBlob, "Could not create test photo");
		bitmap = await createImageBitmap(imageBlob);
		const photo = await importMedia(new File([imageBlob], "pattern.png", { type: "image/png" }));
		const response = await fetch("/tests/fixtures/sample.webm");
		assert(response.ok, "Sample fixture could not be fetched");
		const movie = await importMedia(
			new File([await response.blob()], "sample.webm", { type: "video/webm" }),
		);
		assert(movie.duration >= 1, "Sample video is too short for the trim test");
		const audio = await importMedia(toneFile());
		const project = createProject();
		project.width = 640;
		project.height = 360;
		const effects = ["none", ...CLIP_EFFECTS.map((effect) => effect.id)];
		project.clips = effects.map((effect) => ({
			...createClip(photo),
			duration: 0.8,
			effect,
			fit: "contain",
			caption: effect === "none" ? "기존 자막\n원본 유지" : "",
		}));
		const containStart = project.clips.length * 0.8;
		const coverStart = containStart + 0.4;
		const movieStart = coverStart + 0.4;
		const subtitleStart = movieStart + 0.8;
		project.clips.push(
			{ ...createClip(photo), duration: 0.4, fit: "contain" },
			{ ...createClip(photo), duration: 0.4, fit: "cover" },
			{ ...createClip(movie), trimStart: 0.2, duration: 0.8, effect: "pan-right", volume: 0 },
			{ ...createClip(photo), duration: 1.6, fit: "cover" },
		);
		project.captionStyle = {
			fontSize: 0.06,
			color: "#ff42e8",
			position: "top",
			background: true,
		};
		// Integer frame boundaries also verify inclusive starts and exclusive ends.
		project.captions = parseSrt(
			"1\r\n00:00:10,600 --> 00:00:11,000\r\n한글 자막 첫 줄\r\n둘째 줄\r\n\r\n2\r\n00:00:11,200 --> 00:00:11,800\r\n두 번째 자막\r\n",
		);
		const roundTrip = parseSrt(stringifySrt(project.captions));
		assert(
			roundTrip.every(
				(cue, index) =>
					cue.text === project.captions[index].text &&
					cue.startMs === project.captions[index].startMs &&
					cue.endMs === project.captions[index].endMs,
			),
			"SRT import/export changed subtitle text or timing",
		);
		const trackAt = (start, volume) => ({
			...createAudio(audio),
			start,
			trimStart: 0.1,
			duration: 0.5,
			volume,
		});
		project.audio = [
			trackAt(0.2, 0.4),
			trackAt(0.9, 0.8),
			trackAt(2.2, 0.25),
			trackAt(2.2, 0.25),
			trackAt(3.2, 1),
		];
		const exported = await exportVideo(project, [photo, movie, audio], {
			onProgress: (value) => {
				resultPanel.textContent = `Encoding all effects and timed captions: ${Math.round(value * 100)}%`;
			},
		});
		const decoded = await decodeOutput(exported, project, inputs);
		report.landscape = decoded.metrics;
		attachResult(exported, "#download", "#video");
		resultPanel.textContent = "Comparing decoded effects with preview frames…";
		report.effects = [];
		for (const [index, effect] of effects.entries()) {
			const clip = project.clips[index];
			const start = index * 0.8;
			const errors = [];
			const differences = [];
			for (const offset of [2 / 30, 12 / 30, 22 / 30]) {
				const frame = await decoded.sink.getCanvas(start + offset + 0.00001);
				assert(frame, `Missing decoded frame for ${effect}`);
				const localTime = frame.timestamp - start;
				const expected = frameReference(project, bitmap, clip, localTime, frame.timestamp);
				const withoutEffect = frameReference(
					project,
					bitmap,
					{ ...clip, effect: "none" },
					localTime,
					frame.timestamp,
				);
				const actual = pixels(frame.canvas);
				errors.push(meanDifference(actual, pixels(expected)));
				differences.push(meanDifference(actual, pixels(withoutEffect)));
			}
			const maxPreviewError = Math.max(...errors);
			const maxDifferenceFromNone = Math.max(...differences);
			assert(maxPreviewError < 8, `${effect} output differs from preview: ${maxPreviewError}`);
			if (effect !== "none")
				assert(
					maxDifferenceFromNone > 2,
					`${effect} is indistinguishable from no effect: ${maxDifferenceFromNone}`,
				);
			report.effects.push({ effect, maxPreviewError, maxDifferenceFromNone });
		}

		const contain = await decoded.sink.getCanvas(containStart + 0.2);
		const containPixel = [...contain.canvas.getContext("2d").getImageData(4, 180, 1, 1).data];
		const cover = await decoded.sink.getCanvas(coverStart + 0.2);
		const coverPixel = [...cover.canvas.getContext("2d").getImageData(4, 180, 1, 1).data];
		assert(Math.max(...containPixel.slice(0, 3)) < 25, "Contain does not preserve side bars");
		assert(coverPixel[1] > 65 && coverPixel[2] > 75, "Cover leaves a side bar");
		report.fit = { containPixel, coverPixel };

		const movieInput = new Input({ source: new BlobSource(movie.blob), formats: ALL_FORMATS });
		inputs.push(movieInput);
		const sourceTrack = await movieInput.getPrimaryVideoTrack();
		assert(sourceTrack, "Source video track is missing");
		const movieClip = project.clips.at(-2);
		const movieFrame = await decoded.sink.getCanvas(movieStart + 0.3);
		const sourceFrame = await new CanvasSink(sourceTrack).getCanvas(
			movieClip.trimStart + movieFrame.timestamp - movieStart,
		);
		assert(sourceFrame, "Trimmed video source frame is missing");
		const expectedMovie = frameReference(
			project,
			sourceFrame.canvas,
			movieClip,
			movieFrame.timestamp - movieStart,
			movieFrame.timestamp,
		);
		report.trimmedVideoError = meanDifference(pixels(movieFrame.canvas), pixels(expectedMovie));
		assert(report.trimmedVideoError < 8, "Trimmed moving video differs from its preview");

		report.subtitles = [];
		const subtitleClip = project.clips.at(-1);
		for (const [time, visible] of [
			[10.5, false],
			[10.6, true],
			[10.9, true],
			[11, false],
			[11.4, true],
			[11.8, false],
		]) {
			const frame = await decoded.sink.getCanvas(time + 0.00001);
			const expected = frameReference(
				project,
				bitmap,
				subtitleClip,
				frame.timestamp - subtitleStart,
				frame.timestamp,
			);
			const withoutCaptions = frameReference(
				project,
				bitmap,
				subtitleClip,
				frame.timestamp - subtitleStart,
				frame.timestamp,
				{ captions: [] },
			);
			const actual = pixels(frame.canvas);
			const expectedPixels = pixels(expected);
			const bare = pixels(withoutCaptions);
			const error = meanDifference(actual, expectedPixels);
			let changedTextPixels = 0;
			let changedLowerPixels = 0;
			for (let y = 0; y < project.height; y++) {
				for (let x = 0; x < project.width; x++) {
					const index = (y * project.width + x) * 4;
					if (
						actual[index] > 175 &&
						actual[index + 1] < 135 &&
						actual[index + 2] > 145 &&
						Math.abs(actual[index] - bare[index]) > 50
					) {
						if (y < project.height / 2) changedTextPixels++;
						else changedLowerPixels++;
					}
				}
			}
			assert(error < 8, `Caption frame at ${time}s differs from preview: ${error}`);
			assert(
				visible ? changedTextPixels > 50 : changedTextPixels < 10,
				`Caption visibility is wrong at ${time}s: ${changedTextPixels} text pixels`,
			);
			assert(changedLowerPixels < 10, "Top-positioned captions appeared in the lower half");
			report.subtitles.push({ time, visible, error, changedTextPixels });
		}

		const audioTrack = await decoded.input.getPrimaryAudioTrack();
		assert(audioTrack, "Mixed audio track is missing");
		const quiet = await intervalRms(audioTrack, 0.3, 0.6);
		const louder = await intervalRms(audioTrack, 1, 1.3);
		const mixed = await intervalRms(audioTrack, 2.3, 2.6);
		const unity = await intervalRms(audioTrack, 3.3, 3.6);
		const silenceBefore = await intervalRms(audioTrack, 0.02, 0.1);
		const silenceAfter = await intervalRms(audioTrack, 11.9, 11.98);
		assert(louder > 0.03 && unity > 0.05, "Reference audio is inaudible");
		assert(Math.abs(quiet / louder - 0.5) < 0.05, "Independent audio gain ratio differs");
		assert(Math.abs(mixed / unity - 0.5) < 0.05, "Overlapping tracks were not mixed additively");
		assert(silenceBefore < 0.003 && silenceAfter < 0.003, "Audio leaks beyond chosen intervals");
		report.audio = {
			gainRatio: quiet / louder,
			mixedRatio: mixed / unity,
			silenceBefore,
			silenceAfter,
		};

		const portrait = {
			...createProject(),
			width: 360,
			height: 640,
			clips: [
				{
					...createClip(photo),
					duration: 0.8,
					effect: "tilt",
					fit: "cover",
					caption: "세로 영상\n한글 자막도 유지",
				},
			],
			captionStyle: { fontSize: 0.05, color: "#ffffff", position: "bottom", background: false },
		};
		const portraitExport = await exportVideo(portrait, [photo], {
			onProgress: (value) => {
				resultPanel.textContent = `Encoding portrait and caption style: ${Math.round(value * 100)}%`;
			},
		});
		const portraitDecoded = await decodeOutput(portraitExport, portrait, inputs);
		const portraitFrame = await portraitDecoded.sink.getCanvas(0.4);
		const expectedPortrait = frameReference(
			portrait,
			bitmap,
			portrait.clips[0],
			portraitFrame.timestamp,
			portraitFrame.timestamp,
		);
		const portraitError = meanDifference(pixels(portraitFrame.canvas), pixels(expectedPortrait));
		assert(portraitError < 8, "Portrait effect/caption render differs from preview");
		report.portrait = { ...portraitDecoded.metrics, previewError: portraitError };
		attachResult(portraitExport, "#download-portrait", "#portrait");
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
