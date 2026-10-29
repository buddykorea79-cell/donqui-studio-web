import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
	CLIP_EFFECT_FPS,
	CLIP_EFFECT_VERSION,
	type CreateClipEffectRequest,
	clipEffectDimensions,
	isClipEffectId,
	isClipFit,
} from "../../src/lib/clip-effects/catalog";
import { serveClipSource } from "./clipEffectsSource";

export interface ClipEffectRuntime {
	/** Prebuilt Remotion bundle; separate from the main renderer. */
	bundlePath: string;
	/** Directory containing the packaged renderer's node_modules (or the dev checkout). */
	runtimePath: string;
}

export function validateClipEffectRequest(request: CreateClipEffectRequest): void {
	if (!request || typeof request.sourcePath !== "string" || !path.isAbsolute(request.sourcePath))
		throw new Error("Choose a local video or imported photo first");
	if (
		request.sourceKind !== undefined &&
		request.sourceKind !== "video" &&
		request.sourceKind !== "image"
	)
		throw new Error("Unknown clip source kind");
	if (!isClipEffectId(request.effect)) throw new Error("Unknown clip effect");
	if (request.fit !== undefined && !isClipFit(request.fit)) throw new Error("Unknown clip fit");
	if (
		!Number.isFinite(request.startMs) ||
		!Number.isFinite(request.endMs) ||
		request.startMs < 0 ||
		request.endMs - request.startMs < 100 ||
		request.endMs - request.startMs > 600_000
	)
		throw new Error("Choose a clip between 0.1 seconds and 10 minutes");
	if (
		![request.width, request.height].every(
			(value) => Number.isFinite(value) && value >= 2 && value <= 32768,
		)
	)
		throw new Error("Invalid clip dimensions");
}

/** The content and version are part of the key, so edits to a source never reuse stale effects. */
export async function clipEffectCacheKey(request: CreateClipEffectRequest): Promise<string> {
	validateClipEffectRequest(request);
	const hash = createHash("sha256").update(
		JSON.stringify({
			version: CLIP_EFFECT_VERSION,
			fps: CLIP_EFFECT_FPS,
			startMs: request.startMs,
			endMs: request.endMs,
			effect: request.effect,
			...clipEffectDimensions(request.width, request.height),
			// Only a photo says so: a video's key stays what it was, and so does its cache.
			...(request.sourceKind === "image" ? { sourceKind: "image" } : {}),
			// Likewise only a cover fit: contain is what every earlier render did.
			...(request.fit === "cover" ? { fit: "cover" } : {}),
		}),
	);
	for await (const chunk of createReadStream(request.sourcePath)) hash.update(chunk);
	return hash.digest("hex");
}

/** Prefer installed browsers, so effect creation works offline on ordinary desktops. */
export function clipEffectBrowserCandidates(): string[] {
	const candidates = [process.env.DONQUI_CHROME_PATH];
	if (process.platform === "win32") {
		for (const base of [
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		]) {
			if (base)
				candidates.push(
					path.join(base, "Microsoft/Edge/Application/msedge.exe"),
					path.join(base, "Google/Chrome/Application/chrome.exe"),
				);
		}
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		);
	} else {
		candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
	}
	return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

let queue: Promise<unknown> = Promise.resolve();

/** Serial rendering bounds memory use and makes cache publication atomic across duplicate requests. */
export function createClipEffect(
	request: CreateClipEffectRequest,
	cacheDir: string,
	runtime: ClipEffectRuntime,
) {
	const work = queue.then(() => renderClipEffect(request, cacheDir, runtime));
	queue = work.catch(() => undefined);
	return work;
}

async function renderClipEffect(
	request: CreateClipEffectRequest,
	cacheDir: string,
	runtime: ClipEffectRuntime,
) {
	validateClipEffectRequest(request);
	const source = await stat(request.sourcePath);
	if (!source.isFile() || source.size === 0)
		throw new Error("The source video is empty or unavailable");
	const dimensions = clipEffectDimensions(request.width, request.height);
	const durationInFrames = Math.max(
		1,
		Math.round(((request.endMs - request.startMs) / 1000) * CLIP_EFFECT_FPS),
	);
	const durationMs = (durationInFrames / CLIP_EFFECT_FPS) * 1000;
	const cacheKey = await clipEffectCacheKey(request);
	await mkdir(cacheDir, { recursive: true });
	const filePath = path.join(cacheDir, `${cacheKey}.mp4`);
	if (
		await stat(filePath)
			.then((file) => file.size > 0)
			.catch(() => false)
	)
		return { filePath, durationMs, ...dimensions };
	if (!existsSync(path.join(runtime.bundlePath, "index.html")))
		throw new Error(
			"Clip effects are not built. Run npm run build:clip-effects and restart Donqui Studio.",
		);
	const runtimeRequire = createRequire(path.join(runtime.runtimePath, "package.json"));
	const renderer: typeof import("@remotion/renderer") = runtimeRequire("@remotion/renderer");
	const image = request.sourceKind === "image";
	// A photo has no length of its own to overrun, and no sound.
	const metadata = image
		? null
		: await renderer.getVideoMetadata(request.sourcePath, { logLevel: "error" });
	if (
		metadata &&
		(!metadata.durationInSeconds || request.endMs > metadata.durationInSeconds * 1000 + 50)
	)
		throw new Error("The selected clip extends beyond the source video");
	const browserExecutable = clipEffectBrowserCandidates().find((candidate) =>
		existsSync(candidate),
	);
	if (!browserExecutable)
		throw new Error(
			"Clip effects need Google Chrome or Microsoft Edge. Install either browser or set DONQUI_CHROME_PATH.",
		);
	const server = await serveClipSource(request.sourcePath);
	const temporary = path.join(cacheDir, `${randomUUID()}.tmp.mp4`);
	try {
		const inputProps = {
			sourceUrl: server.sourceUrl,
			startMs: request.startMs,
			effect: request.effect,
			sourceKind: image ? ("image" as const) : ("video" as const),
			fit: request.fit ?? ("contain" as const),
		};
		const composition = await renderer.selectComposition({
			serveUrl: runtime.bundlePath,
			id: "DonquiClipEffect",
			inputProps,
			browserExecutable,
			logLevel: "error",
		});
		await renderer.renderMedia({
			composition: { ...composition, ...dimensions, durationInFrames },
			serveUrl: runtime.bundlePath,
			inputProps,
			browserExecutable,
			codec: "h264",
			// Photos and silent videos must stay without an audio stream. Otherwise the
			// synthetic silent AAC track makes automatic transcription treat them as speech.
			muted: metadata === null || metadata.audioCodec === null,
			pixelFormat: "yuv420p",
			crf: 18,
			concurrency: 2,
			outputLocation: temporary,
			logLevel: "error",
		});
		if ((await stat(temporary)).size === 0)
			throw new Error("Clip rendering produced an empty file");
		await rename(temporary, filePath);
		return { filePath, durationMs, ...dimensions };
	} finally {
		await server.close();
		await rm(temporary, { force: true });
	}
}
