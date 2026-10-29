const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { launchDirect } = require("./electron-direct-launch.cjs");
const root = process.cwd();
const validation = path.join(root, ".local", "donqui-validation");
const profile = path.join(validation, `profile-${Date.now()}`);
const native = path.join(root, "electron", "native", "bin", "win32-x64");
const ffmpeg = path.join(native, "ffmpeg-shared.exe");
const photo = path.join(validation, "photo 한글.png");
const video = path.join(validation, "video.mp4");
const audio = path.join(validation, "music.wav");
const narration = path.join(validation, "narration.wav");
const output = path.join(validation, "donqui-final.mp4");

function fixture(args) {
	const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
		windowsHide: true,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
}
async function savedDocument(check, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const dir = path.join(profile, "projects");
		for (const file of (await fs.readdir(dir).catch(() => [])).filter((f) =>
			f.endsWith(".openscreen"),
		)) {
			const doc = await fs
				.readFile(path.join(dir, file), "utf8")
				.then(JSON.parse)
				.catch(() => null);
			if (doc && check(doc)) return doc;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Expected project state was not persisted");
}
async function launch() {
	const env = {
		...process.env,
		DONQUI_USER_DATA: profile,
		OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
		PATH: `${native}${path.delimiter}${process.env.PATH}`,
	};
	delete env.ELECTRON_RUN_AS_NODE;
	// Not Playwright's `_electron.launch`: see electron-direct-launch.cjs.
	return launchDirect({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: [".", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
		cwd: root,
		env,
	});
}
(async () => {
	await fs.mkdir(validation, { recursive: true });
	fixture(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-frames:v", "1", photo]);
	fixture([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=30",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=880:sample_rate=48000",
		"-t",
		"4",
		"-c:v",
		"libopenh264",
		"-b:v",
		"2M",
		"-c:a",
		"aac",
		video,
	]);
	fixture(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", audio]);
	fixture(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100", "-t", "3", narration]);
	let app = await launch();
	let page;
	try {
		page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("RENDERER", error.message));
		await page.getByRole("button", { name: "Donqui Studio", exact: true }).waitFor();
		assert.equal((await page.getByRole("tab").allTextContents())[0], "Audio");
		await page
			.getByRole("button", { name: /^(새 프로젝트|New project)$/ })
			.first()
			.click();
		await page.locator("#np-name").fill("Donqui audio-led validation");
		await page.getByRole("button", { name: /^(프로젝트 만들기|Create project)$/ }).click();
		assert.equal(
			await page.getByRole("tab", { name: "Audio", exact: true }).getAttribute("aria-selected"),
			"true",
		);
		await app.evaluate(
			({ dialog }, files) => {
				dialog.showOpenDialog = async (options) => ({
					canceled: false,
					filePaths: [
						options.filters?.[0]?.extensions?.includes("png")
							? files.photo
							: options.filters?.[0]?.extensions?.includes("mp3")
								? files.audio
								: files.video,
					],
				});
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.output });
			},
			{ photo, video, audio, output },
		);
		// Audio: the music becomes a layer, is trimmed to 5 s at 80%, previewed, then mixed into
		// the one track the programme plays.
		await page.getByRole("button", { name: "음악 가져오기", exact: true }).click();
		await savedDocument((doc) => doc.audioBoard?.layers?.length === 1);
		const outPoint = page.getByLabel("원본 끝 (초)", { exact: true });
		await outPoint.fill("5");
		await outPoint.press("Enter");
		const volume = page.getByLabel("볼륨 (%)", { exact: true });
		await volume.fill("80");
		await volume.press("Enter");
		await savedDocument(
			(doc) => doc.audioBoard.layers[0].outSec === 5 && doc.audioBoard.layers[0].volume === 80,
		);
		// A mono narration on a second layer, from 1 s.
		await app.evaluate(({ dialog }, file) => {
			const earlier = dialog.showOpenDialog;
			dialog.showOpenDialog = async (options) =>
				options.filters?.[0]?.extensions?.includes("mp3")
					? { canceled: false, filePaths: [file] }
					: earlier(options);
		}, narration);
		await page.getByRole("button", { name: "나레이션 가져오기", exact: true }).click();
		await savedDocument((doc) => doc.audioBoard?.layers?.length === 2);
		const narrationStart = page.getByLabel("타임라인 시작 (초)", { exact: true });
		await narrationStart.fill("1");
		await narrationStart.press("Enter");
		await savedDocument((doc) => doc.audioBoard.layers[1].startSec === 1);
		assert.equal((await savedDocument(() => true)).audioTracks.length, 0);
		// Reused as a clip: Ctrl+D puts a copy right after it on its track, Delete takes the copy
		// away again, and the file stays in the library either way.
		await page.getByRole("button", { name: "narration.wav 클립" }).first().click();
		await page.keyboard.press("Control+d");
		let layered = await savedDocument((value) => value.audioBoard?.layers?.length === 3);
		const copy = layered.audioBoard.layers[2];
		assert.deepEqual([copy.startSec, copy.row], [4, layered.audioBoard.layers[1].row]);
		await page.keyboard.press("Delete");
		layered = await savedDocument((value) => value.audioBoard?.layers?.length === 2);
		assert(layered.audioBoard.library.some((entry) => entry.kind === "voiceover"));
		await page
			.getByRole("region", { name: "오디오 클립" })
			.getByText(/1번 사용/)
			.first()
			.waitFor();
		console.log(
			"PASS Audio clips: duplicated with Ctrl+D onto its track, deleted, kept in the library",
		);
		await page.getByRole("button", { name: "미리듣기", exact: true }).click();
		await page.waitForTimeout(350);
		await page.getByRole("button", { name: "일시 정지", exact: true }).click();
		await page.getByRole("button", { name: "Media에 반영", exact: true }).click();
		let doc = await savedDocument(
			(value) =>
				value.audioTracks.length === 1 &&
				value.audioTracks[0].endMs === 5000 &&
				value.audioTracks[0].timelineLocked &&
				value.audioBoard?.mix?.assetId === value.audioTracks[0].assetId,
		);
		const mixFile = doc.assets.find(
			(asset) => asset.id === doc.audioBoard.mix.assetId,
		).originalPath;
		assert(/[\\/]audio-mixes[\\/]/.test(mixFile), `mix not written by the mixer: ${mixFile}`);
		const mixProbe = JSON.parse(
			spawnSync(
				path.join(root, "node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"),
				["-v", "error", "-show_streams", "-show_format", "-of", "json", mixFile],
				{ windowsHide: true, encoding: "utf8" },
			).stdout,
		);
		assert(Math.abs(Number(mixProbe.format.duration) - 5) < 0.01, "the mix is not 5 s long");
		assert.equal(mixProbe.streams[0].channels, 2);
		// Both sines are -18 dBFS mono files. The music alone at 80% is -20 dB on each side — a mono
		// file spread at full level — and the narration raises the peak only from 1 s to 4 s.
		const peakDb = (from, to) =>
			Number(
				/max_volume: (-?[\d.]+) dB/.exec(
					spawnSync(
						ffmpeg,
						[
							"-hide_banner",
							"-nostats",
							"-i",
							mixFile,
							"-af",
							`atrim=${from}:${to},volumedetect`,
							"-f",
							"null",
							"-",
						],
						{ windowsHide: true, encoding: "utf8" },
					).stderr,
				)?.[1],
			);
		const peaks = [peakDb(0.2, 0.8), peakDb(1.5, 3.5), peakDb(4.2, 4.8)];
		assert(Math.abs(peaks[0] + 20) < 0.6 && Math.abs(peaks[2] + 20) < 0.6, `music peaks ${peaks}`);
		assert(peaks[1] > peaks[0] + 4, `the narration is missing from 1-4 s: ${peaks}`);
		// Applying takes the user on to Media, where the mix is the timeline's top row.
		await page
			.getByRole("region", { name: "Media 타임라인" })
			.getByText("오디오 믹스 · 0:05.0")
			.waitFor();
		await page.screenshot({ path: path.join(validation, "audio-to-media.png") });
		console.log(
			`PASS Audio first: 8s music (trimmed to 5s, 80%) and a mono narration from 1s as layers, previewed and mixed into one ${Number(mixProbe.format.duration).toFixed(3)}s stereo track; peaks ${peaks.map((peak) => peak.toFixed(1)).join(" / ")} dB`,
		);
		// V.Clip: split a range of the video. Only the range is recorded; nothing renders here.
		await page.getByRole("tab", { name: "V.Clip", exact: true }).click();
		await page.getByRole("button", { name: "영상 가져오기", exact: true }).first().click();
		const panel = page.getByRole("region", { name: "video.mp4 구간" });
		await panel.getByText(/640×360/).waitFor({ timeout: 60000 });
		await panel.getByRole("button", { name: /구간 직접 추가/ }).click();
		const card = panel.getByRole("article").first();
		await card.getByText(/^0:00\.0–0:04\.0/).waitFor();
		await card.getByLabel("길이 (초)", { exact: true }).fill("3.5");
		await card.getByLabel("길이 (초)", { exact: true }).press("Enter");
		await card.getByText("0:00.0–0:03.5 · 3.5초").waitFor();
		await card.getByRole("button", { name: /구간 미리보기$/ }).click();
		await card.locator("video").waitFor();
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(validation, "vclip.png") });
		await page
			.getByRole("button", { name: /선택한 구간 1개 클립으로 나누기/ })
			.first()
			.click();
		doc = await savedDocument((value) => value.mediaBoard?.clips?.length === 1);
		assert.deepEqual([doc.mediaBoard.clips[0].startSec, doc.mediaBoard.clips[0].endSec], [0, 3.5]);
		assert.equal(doc.timeline.clips.length, 0);
		console.log("PASS V.Clip: a 3.5 s range split into Media's bin, nothing rendered or placed");

		// Media: a photo with a random effect, then the clip zoomed, fitted to the 5 s of music.
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		await page.getByRole("tab", { name: /^사진/ }).click();
		await page.getByRole("button", { name: "사진 추가", exact: true }).click();
		doc = await savedDocument((value) => value.mediaBoard?.images?.length === 1);
		assert.deepEqual([doc.mediaBoard.images[0].width, doc.mediaBoard.images[0].height], [640, 360]);
		await page.getByLabel("사진 길이 (초)", { exact: true }).fill("2");
		await page.getByLabel("새 항목 효과", { exact: true }).selectOption("random");
		await page.getByRole("button", { name: "타임라인에 추가", exact: true }).click();
		await page.getByRole("tab", { name: /^V\.Clip 클립/ }).click();
		await page.getByLabel("새 항목 효과", { exact: true }).selectOption("zoom-in");
		await page.getByRole("button", { name: "타임라인에 추가", exact: true }).click();
		doc = await savedDocument((value) => value.mediaBoard?.items?.length === 2);
		const timeline = page.getByRole("region", { name: "Media 타임라인" });
		await timeline.getByText("0:00.5 넘침").waitFor();
		// The clip dragged in front of the photo, with the pointer, on the timeline itself.
		const photoBlock = timeline.getByRole("button", { name: /^1번/ });
		const clipBlock = timeline.getByRole("button", { name: /^2번/ });
		const from = await clipBlock.boundingBox();
		const to = await photoBlock.boundingBox();
		assert(from && to, "timeline blocks have no box");
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
		await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 12 });
		await page.mouse.up();
		doc = await savedDocument((value) => value.mediaBoard.items[0].kind === "clip");
		// Ctrl+wheel stretches the timeline out, and the fit button brings it back to one view.
		const lanes = timeline.getByLabel("영상·사진 줄");
		const narrow = (await lanes.boundingBox())?.width ?? 0;
		await lanes.hover();
		await page.keyboard.down("Control");
		await page.mouse.wheel(0, -300);
		await page.keyboard.up("Control");
		await page.waitForTimeout(300);
		const wide = (await lanes.boundingBox())?.width ?? 0;
		assert(wide > narrow * 1.1, `Ctrl+wheel did not stretch the timeline: ${narrow} -> ${wide}`);
		await timeline.getByRole("button", { name: "타임라인 전체 보기" }).click();
		console.log(
			`PASS Media timeline: clip dragged before the photo, Ctrl+wheel ${narrow.toFixed(0)} → ${wide.toFixed(0)} px`,
		);
		await timeline.getByRole("button", { name: /Audio 길이에 맞추기/ }).click();
		const total = (value) =>
			value.mediaBoard.items.reduce((sum, item) => sum + item.endSec - item.startSec, 0);
		doc = await savedDocument((value) => Math.abs(total(value) - 5) < 0.02);
		console.log(
			`PASS Media fit: 2 s photo + 3.5 s clip fitted to the 5 s bed → ${doc.mediaBoard.items
				.map((item) => (item.endSec - item.startSec).toFixed(3))
				.join(" + ")}`,
		);
		// The whole composition plays in the project's frame, over the mix: the clip first, then
		// the photo, through Remotion's <Img>.
		const composition = page.getByRole("region", { name: "조합" });
		await composition.getByRole("button", { name: "재생" }).click();
		await composition.locator("img").first().waitFor({ timeout: 60000 });
		await page.waitForTimeout(800);
		await composition.getByRole("button", { name: "일시 정지" }).click();
		await page.screenshot({ path: path.join(validation, "media-compose.png") });
		await page.getByRole("button", { name: /Edit에 반영/ }).click();
		doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 2 &&
				Math.abs(value.timeline.clips[1].timelineEndSec - 5) < 0.04,
			600000,
		);
		assert.equal(doc.audioTracks[0].endMs, 5000);
		// Rendered in the project's frame, and shown filling Edit's frame.
		assert.equal(doc.legacyEditor.padding, 0, "the picture floats instead of filling the frame");
		for (const clip of doc.timeline.clips) {
			const asset = doc.assets.find((entry) => entry.id === clip.assetId);
			assert.deepEqual(
				[asset.video.width, asset.video.height],
				[1920, 1080],
				`${asset.originalPath} is not in the project's frame`,
			);
		}
		const placed = doc.timeline.clips.map(
			(clip) => doc.assets.find((asset) => asset.id === clip.assetId)?.originalPath ?? "",
		);
		assert(/[\\/]clip-effects[\\/]/.test(placed[0]), `photo not rendered: ${placed[0]}`);
		assert(/[\\/]clip-effects[\\/]/.test(placed[1]), `clip not rendered: ${placed[1]}`);
		await page.screenshot({ path: path.join(validation, "media-applied.png") });
		console.log(
			"PASS Media apply: photo (random effect) and clip (zoom-in) rendered by Remotion, 5 s picture, music bed intact",
		);
		await fs.writeFile(path.join(validation, "project.openscreen"), JSON.stringify(doc, null, 2));
		await page.getByRole("tab", { name: /^(편집|Edit)$/ }).click();
		// Subtitles from the keyboard: N for a caption at the playhead, Shift+N for a title.
		await page.locator("body").click({ position: { x: 5, y: 300 } });
		await page.keyboard.press("n");
		await page.getByLabel("자막 내용", { exact: true }).fill("자막 테스트");
		await page.getByLabel("자막 내용", { exact: true }).press("Enter");
		doc = await savedDocument((value) =>
			value.annotations.some((region) => region.subtitleKind === "caption"),
		);
		await page.keyboard.press("Escape");
		await page.locator("body").click({ position: { x: 5, y: 300 } });
		await page.keyboard.press("Shift+N");
		await page.getByLabel("자막 내용", { exact: true }).fill("타이틀 테스트");
		await page.getByLabel("자막 내용", { exact: true }).press("Enter");
		doc = await savedDocument((value) =>
			value.annotations.some((region) => region.subtitleKind === "title"),
		);
		// A subtitle crossing a cut is stored as one fragment per clip; count each once.
		const texts = [
			...new Set(
				doc.annotations
					.filter((region) => region.subtitleKind)
					.map((region) => JSON.stringify([region.subtitleKind, region.content])),
			),
		].map((entry) => JSON.parse(entry));
		assert.deepEqual(texts, [
			["caption", "자막 테스트"],
			["title", "타이틀 테스트"],
		]);
		console.log("PASS Edit subtitles: N and Shift+N put a caption and a title in at the playhead");
		await page.screenshot({ path: path.join(validation, "editor.png") });
		// Settings, from the brand menu above AI settings: 720p, which the export then opens on.
		await page.getByRole("button", { name: "Donqui Studio", exact: true }).click();
		await page.getByRole("menuitem", { name: "설정", exact: true }).click();
		await page.getByRole("button", { name: /^720p/ }).click();
		await savedDocument((value) => value.legacyEditor?.outputResolution === "720p");
		await page.screenshot({ path: path.join(validation, "settings.png") });
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: /^(내보내기|Export)$/, exact: true }).click();
		await page.getByRole("button", { name: /^(MP4 내보내기|Export MP4)$/, exact: true }).click();
		await page.getByTestId("export-show-in-folder").waitFor({ timeout: 120000 });
		const probe = spawnSync(
			path.join(root, "node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"),
			["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
			{ windowsHide: true, encoding: "utf8" },
		);
		assert.equal(probe.status, 0, probe.stderr);
		const outputInfo = JSON.parse(probe.stdout);
		assert(Math.abs(Number(outputInfo.format.duration) - 5) < 0.1);
		assert(outputInfo.streams.some((stream) => stream.codec_type === "audio"));
		const picture = outputInfo.streams.find((stream) => stream.codec_type === "video");
		assert.deepEqual([picture.width, picture.height], [1280, 720], "not exported at the 720p set");
		fixture(["-i", output, "-f", "null", "-"]);
		fixture([
			"-ss",
			"0.75",
			"-i",
			output,
			"-frames:v",
			"1",
			path.join(validation, "export-frame.png"),
		]);
		await fs.writeFile(path.join(validation, "ffprobe.json"), probe.stdout);
		console.log(
			"PASS native MP4 export: 5s picture + audio at the 720p Settings chose, full decode and frame extraction",
		);
		await page
			.getByRole("button", { name: /^(닫기|Close)$/, exact: true })
			.last()
			.click();
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByText("Donqui audio-led validation", { exact: true }).first().waitFor();
		console.log("PASS restart: audio-led project restored");
		// The photo is rendered from its original file, which only the project names after a
		// restart: applying again proves the main process approved it from the document.
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		const before = doc.timeline.clips.map((clip) => clip.id).join();
		await page.getByRole("button", { name: /Edit에 반영/ }).click();
		await page.getByRole("button", { name: "바꾸기", exact: true }).click();
		doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 2 &&
				value.timeline.clips.map((clip) => clip.id).join() !== before,
			120000,
		);
		assert.equal(doc.mediaBoard.items.length, 2);
		// The subtitles follow the narration: replacing the pictures leaves them where they were.
		const kinds = new Set(doc.annotations.map((region) => region.subtitleKind).filter(Boolean));
		assert.deepEqual(
			[...kinds].sort(),
			["caption", "title"],
			"the subtitles went with the old clips",
		);
		console.log(
			"PASS restart: composition persisted and re-applied (720p renders), subtitles kept at their times",
		);
		await fs.writeFile(path.join(validation, "profile.txt"), profile);
	} catch (error) {
		console.error("SMOKE FAILURE", error);
		if (page && !page.isClosed())
			await fs.writeFile(
				path.join(validation, "failure-accessibility.txt"),
				await page.locator("body").ariaSnapshot(),
			);
		if (page && !page.isClosed())
			await page
				.screenshot({ path: path.join(validation, "failure.png"), timeout: 5000 })
				.catch(() => undefined);
		throw error;
	} finally {
		await app.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
