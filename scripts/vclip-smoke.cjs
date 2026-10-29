// V.Clip and Media on real footage, in the real Electron app:
//   npm run build-vite && node scripts/vclip-smoke.cjs <video>... [--photo=<jpg>] [--no-ai]
// Imports 20 s of music, then every <video> at once in V.Clip, which analyses them one after
// another (with the Ollama model chosen in AI settings, or frame quality alone with --no-ai).
// A segment is previewed and adjusted, enough segments to cover the music are split into
// Media's bin, and Media composes them — with the photo, when one is given — under random
// Remotion effects, fits them to the music and renders them onto the timeline. Uses a fresh
// profile under .local/vclip-validation; native file pickers are replaced only inside this
// run. Screenshots land next to the profile.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { launchDirect } = require("./electron-direct-launch.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const sources = args.filter((arg) => !arg.startsWith("--")).map((arg) => path.resolve(arg));
const photo = args.find((arg) => arg.startsWith("--photo="))?.slice("--photo=".length);
const withoutAi = args.includes("--no-ai");
const validation = path.join(root, ".local", "vclip-validation");
const profile = path.join(validation, `profile-${Date.now()}`);
const native = path.join(root, "electron", "native", "bin", "win32-x64");
const audio = path.join(validation, "music 20s.wav");
const MUSIC_SEC = 20;

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
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Expected project state was not persisted");
}

const itemSec = (doc) =>
	doc.mediaBoard.items.reduce((sum, item) => sum + item.endSec - item.startSec, 0);

/** Pairs of clips of one source that show more of the same footage in `after` than in `before`. */
function footageShownTwice(before, after) {
	const shared = (left, right) =>
		Math.max(0, Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec));
	const was = new Map(before.map((item) => [item.id, item]));
	const clips = after.filter((item) => item.kind !== "image" && was.has(item.id));
	const pairs = [];
	for (const [index, item] of clips.entries())
		for (const other of clips.slice(index + 1)) {
			if (other.assetId !== item.assetId) continue;
			const grown = shared(item, other) - shared(was.get(item.id), was.get(other.id));
			if (grown > 0.01)
				pairs.push(`${item.startSec}–${item.endSec} & ${other.startSec}–${other.endSec}`);
		}
	return pairs;
}

(async () => {
	if (sources.length === 0)
		throw new Error("Usage: node scripts/vclip-smoke.cjs <video>... [--photo=<jpg>] [--no-ai]");
	for (const source of sources) await fs.access(source);
	if (photo) await fs.access(photo);
	await fs.mkdir(validation, { recursive: true });
	const made = spawnSync(
		path.join(native, "ffmpeg-shared.exe"),
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=330:sample_rate=48000",
			"-t",
			String(MUSIC_SEC),
			audio,
		],
		{ windowsHide: true, encoding: "utf8" },
	);
	assert.equal(made.status, 0, made.stderr);
	const env = {
		...process.env,
		DONQUI_USER_DATA: profile,
		OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
	};
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await launchDirect({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: [".", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
		cwd: root,
		env,
	});
	let closing = false;
	app.process().on("exit", (code, signal) => {
		if (!closing) console.error(`Electron exited early: code=${code} signal=${signal}`);
	});
	let page;
	const started = Date.now();
	const log = (message) =>
		console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
	try {
		page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("RENDERER", error.message));
		await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
		await page.getByRole("button", { name: "Donqui Studio", exact: true }).waitFor();
		await page
			.getByRole("button", { name: /^(새 프로젝트|New project)$/ })
			.first()
			.click();
		await page.locator("#np-name").fill("V.Clip validation");
		await page.getByRole("button", { name: /^(프로젝트 만들기|Create project)$/ }).click();
		await app.evaluate(
			({ dialog }, files) => {
				dialog.showOpenDialog = async (options) => {
					const extensions = options.filters?.[0]?.extensions ?? [];
					if (extensions.includes("mp3")) return { canceled: false, filePaths: [files.audio] };
					if (extensions.includes("jpg"))
						return { canceled: !files.photo, filePaths: files.photo ? [files.photo] : [] };
					return { canceled: false, filePaths: files.sources };
				};
			},
			{ audio, sources, photo: photo ?? null },
		);
		// The music is a clip until it is mixed into the one track Media fits to; applying the mix
		// moves on to Media by itself.
		await page.getByRole("button", { name: "음악 가져오기", exact: true }).click();
		await savedDocument((doc) => doc.audioBoard?.layers?.length === 1);
		await page.getByRole("button", { name: "Media에 반영", exact: true }).click();
		await savedDocument(
			(doc) =>
				doc.audioTracks.length === 1 &&
				doc.audioTracks[0].endMs === MUSIC_SEC * 1000 &&
				doc.audioBoard.mix?.assetId === doc.audioTracks[0].assetId,
		);
		// Applying the mix goes on to Media, whose timeline shows it on the top row.
		await page
			.getByRole("region", { name: "Media 타임라인" })
			.getByText(/^오디오 믹스 · /)
			.waitFor();
		log(`PASS Audio: ${MUSIC_SEC} s music bed imported as a clip, mixed, and shown in Media`);

		// V.Clip: every video on one page.
		await page.getByRole("tab", { name: "V.Clip", exact: true }).click();
		await page.getByRole("button", { name: "영상 가져오기", exact: true }).click();
		const panels = sources.map((source) =>
			page.getByRole("region", { name: `${path.basename(source)} 구간` }),
		);
		for (const [index, panel] of panels.entries()) {
			const probe = panel.getByText(/\d+×\d+/).first();
			await probe.waitFor({ timeout: 120000 });
			log(`PASS probed ${path.basename(sources[index])}: ${await probe.textContent()}`);
		}
		assert.equal(await page.getByLabel("클립 길이 (초)", { exact: true }).inputValue(), "5");

		// The model is chosen in AI settings now.
		await page.getByText(/분석 모델 |Ollama 연결 안 됨|비전 모델 없음|AI 없이/).waitFor();
		await page.getByRole("button", { name: /AI 설정/ }).click();
		const ollama = page.getByRole("region", { name: "로컬 비전 모델 (Ollama)" });
		await ollama.waitFor();
		await ollama
			.getByText(/연결됨 ·|연결할 수 없습니다|비전 모델이 없습니다/)
			.waitFor({ timeout: 20000 });
		if (withoutAi) await ollama.getByLabel("모델", { exact: true }).selectOption("");
		const model = await ollama.getByLabel("모델", { exact: true }).inputValue();
		await page.screenshot({ path: path.join(validation, "ai-settings.png") });
		await page.keyboard.press("Escape");
		await ollama.waitFor({ state: "detached" });
		const status = await page
			.getByText(/분석 모델 |Ollama 연결 안 됨|비전 모델 없음|AI 없이/)
			.textContent();
		log(
			`PASS AI settings hold the Ollama model: ${model || "(frame quality only)"} → V.Clip says "${status}"`,
		);

		await page.getByRole("button", { name: /모든 영상 구간 찾기/ }).click();
		await page
			.getByRole("button", { name: /분석 멈추기/ })
			.first()
			.waitFor();
		await page
			.getByRole("button", { name: /모든 영상 구간 찾기/ })
			.waitFor({ timeout: 45 * 60 * 1000 });
		let total = 0;
		for (const [index, panel] of panels.entries()) {
			const cards = panel.getByRole("article");
			const count = await cards.count();
			assert(count > 0, `V.Clip found no segments in ${sources[index]}`);
			total += count;
			log(`${path.basename(sources[index])}: ${count} segments`);
			for (let card = 0; card < Math.min(count, 3); card++)
				log(`  ${(await cards.nth(card).innerText()).replace(/\s+/g, " ").slice(0, 150)}`);
		}
		const failures = await page.getByText(/AI가 \d+개 구간을 판단하지 못해/).count();
		if (model) assert.equal(failures, 0, "the vision model failed on some segments");
		await page.screenshot({ path: path.join(validation, "vclip-segments.png") });
		log(
			`PASS analysis of ${sources.length} videos: ${total} segments${model ? ` judged by ${model}` : ""}`,
		);

		// Preview a segment and set its end from playback; nudge another.
		const card = panels[0].getByRole("article").first();
		const range = /(\d+:\d+\.\d)–(\d+:\d+\.\d) · ([\d.]+)초/;
		const before = range.exec(await card.innerText());
		await card.getByRole("button", { name: /구간 미리보기$/ }).click();
		const video = card.locator("video");
		await video.waitFor({ timeout: 30000 });
		await page.waitForFunction(
			(element) => element && element.readyState >= 2 && !element.paused,
			await video.elementHandle(),
			{ timeout: 60000 },
		);
		await page.waitForTimeout(1800);
		const playing = await video.evaluate((element) => element.currentTime);
		await page.screenshot({ path: path.join(validation, "vclip-preview.png") });
		await card.getByRole("button", { name: "여기를 끝으로", exact: true }).click();
		// The card shows its range on the poster, which the player covers while it plays.
		await card.getByRole("button", { name: "미리보기 닫기", exact: true }).click();
		const after = range.exec(await card.innerText());
		log(
			`PASS preview plays the source (${playing.toFixed(2)} s); end set from playback: ${before[0]} → ${after[0]}`,
		);
		assert.notEqual(after[2], before[2]);
		const second = panels[0].getByRole("article").nth(1);
		const secondBefore = range.exec(await second.innerText())[0];
		await second.getByRole("button", { name: "시작 +0.5초", exact: true }).click();
		const secondAfter = range.exec(await second.innerText())[0];
		assert.notEqual(secondAfter, secondBefore);
		log(`PASS nudged: ${secondBefore} → ${secondAfter}`);

		// Split enough to cover the music; ranges only, nothing rendered.
		await page.getByRole("button", { name: "선택 해제", exact: true }).click();
		await page.getByRole("button", { name: "남은 Audio만큼 선택", exact: true }).click();
		const split = page.getByRole("button", { name: /선택한 구간 \d+개 클립으로 나누기/ }).first();
		const selected = Number(/선택한 구간 (\d+)개/.exec(await split.textContent())[1]);
		assert(selected > 0);
		const splitStarted = Date.now();
		await split.click();
		let doc = await savedDocument((value) => value.mediaBoard?.clips?.length === selected);
		assert.equal(doc.timeline.clips.length, 0);
		log(
			`PASS split ${selected} clips into Media's bin in ${Date.now() - splitStarted} ms: ${doc.mediaBoard.clips
				.map((clip) => `${clip.label}${clip.note ? ` “${clip.note}”` : ""}`)
				.join(" | ")}`,
		);

		// Media: compose under random effects, with the photo, fit to the music and apply.
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		await page.getByLabel("새 항목 효과", { exact: true }).selectOption("random");
		await page.getByRole("button", { name: /모두 타임라인에 추가/ }).click();
		await savedDocument((value) => value.mediaBoard?.items?.length === selected);
		if (photo) {
			await page.getByRole("tab", { name: /^사진/ }).click();
			await page.getByRole("button", { name: "사진 추가", exact: true }).click();
			await page.getByRole("button", { name: "타임라인에 추가", exact: true }).click();
			await savedDocument((value) => value.mediaBoard?.items?.length === selected + 1);
		}
		const unfitted = (await savedDocument(() => true)).mediaBoard.items;
		await page
			.getByRole("region", { name: "Media 타임라인" })
			.getByRole("button", { name: /Audio 길이에 맞추기/ })
			.click();
		doc = await savedDocument((value) => Math.abs(itemSec(value) - MUSIC_SEC) < 0.05);
		const twice = footageShownTwice(unfitted, doc.mediaBoard.items);
		// Reusing footage is allowed only when the unused footage falls short — and then it says so.
		if (twice.length > 0)
			await page
				.getByText(/같은 장면을 다시 씁니다/)
				.first()
				.waitFor({ timeout: 10000 });
		log(
			`PASS fit to ${MUSIC_SEC} s: ${doc.mediaBoard.items
				.map((item) => `${item.kind} ${(item.endSec - item.startSec).toFixed(2)}`)
				.join(
					" + ",
				)}; ${twice.length === 0 ? "no footage shown twice" : `footage reused, with a warning: ${twice.join(", ")}`}`,
		);
		// The whole composition plays over the music in the project's frame.
		const composition = page.getByRole("region", { name: "조합" });
		await composition.getByRole("button", { name: "재생" }).click();
		await page.waitForTimeout(2500);
		await page.screenshot({ path: path.join(validation, "media-compose.png") });
		await composition.getByRole("button", { name: "일시 정지" }).click();

		const applyStarted = Date.now();
		await page.getByRole("button", { name: /Edit에 반영/ }).click();
		const items = doc.mediaBoard.items.length;
		doc = await savedDocument((value) => value.timeline.clips.length === items, 60 * 60 * 1000);
		const pictureSec = doc.timeline.clips.at(-1).timelineEndSec;
		log(
			`timeline after ${((Date.now() - applyStarted) / 1000).toFixed(0)} s: ${doc.timeline.clips.length} clips, ${pictureSec.toFixed(2)} s`,
		);
		assert(Math.abs(pictureSec - MUSIC_SEC) < 0.1, "the picture does not end with the music");
		assert.equal(doc.audioTracks[0].endMs, MUSIC_SEC * 1000);
		for (const clip of doc.timeline.clips) {
			const asset = doc.assets.find((entry) => entry.id === clip.assetId);
			log(`  ${asset.label} (${(clip.timelineEndSec - clip.timelineStartSec).toFixed(2)} s)`);
		}
		await page.screenshot({ path: path.join(validation, "media-applied.png") });
		await fs.writeFile(path.join(validation, "project.openscreen"), JSON.stringify(doc, null, 2));
		log("PASS composition rendered with random Remotion effects and placed to end with the music");
	} catch (error) {
		console.error("VCLIP SMOKE FAILURE", error);
		if (page && !page.isClosed())
			await page
				.screenshot({ path: path.join(validation, "failure.png"), timeout: 5000 })
				.catch(() => undefined);
		throw error;
	} finally {
		closing = true;
		await app.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
