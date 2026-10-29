import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveFfmpeg } from "./audioPeaks";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];

/**
 * The frame a photo is made into: the project's output frame, filled (`cover`, cropping what
 * spills over) or with the whole photo in it (`contain`, on black). Absent, the photo keeps its
 * own shape within 1080p, as every photo clip made before the setting did.
 */
export interface ImageClipFrame {
	width: number;
	height: number;
	fit: "cover" | "contain";
}

export function validateImageClipFrame(frame: unknown): ImageClipFrame | undefined {
	if (frame === undefined || frame === null) return undefined;
	const value = frame as Partial<ImageClipFrame>;
	const side = (n: unknown) =>
		typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= 4096 && n % 2 === 0;
	if (
		!side(value.width) ||
		!side(value.height) ||
		(value.fit !== "cover" && value.fit !== "contain")
	)
		throw new Error("Invalid photo frame");
	return { width: value.width as number, height: value.height as number, fit: value.fit };
}

function frameFilter(frame: ImageClipFrame | undefined): string {
	if (!frame)
		return "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p";
	const { width, height } = frame;
	return frame.fit === "cover"
		? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`
		: `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
}

export function imageClipArgs(
	input: string,
	duration: number,
	output: string,
	frame?: ImageClipFrame,
): string[] {
	if (!Number.isFinite(duration) || duration < 0.5 || duration > 600)
		throw new Error("Photo duration must be between 0.5 and 600 seconds");
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-threads",
		"2",
		"-loop",
		"1",
		"-framerate",
		"30",
		"-i",
		input,
		"-t",
		String(duration),
		"-vf",
		frameFilter(frame),
		"-an",
		"-c:v",
		"libopenh264",
		"-b:v",
		// A still costs little per pixel, but a 4K frame still needs more than a 1080p one.
		frame && Math.min(frame.width, frame.height) > 1080 ? "16M" : "6M",
		"-threads",
		"2",
		"-filter_threads",
		"1",
		"-movflags",
		"+faststart",
		output,
	];
}
let queue: Promise<unknown> = Promise.resolve();
/** Serial, content-addressed conversion; original images are read only. */
export function createImageClip(
	input: string,
	duration: number,
	cacheDir: string,
	frame?: ImageClipFrame,
): Promise<string> {
	const work = queue.then(() => convert(input, duration, cacheDir, frame));
	queue = work.catch(() => undefined);
	return work;
}
async function convert(
	input: string,
	duration: number,
	cacheDir: string,
	frame: ImageClipFrame | undefined,
): Promise<string> {
	imageClipArgs(input, duration, "validate.mp4", frame);
	if (!IMAGE_EXTENSIONS.includes(path.extname(input).slice(1).toLowerCase()))
		throw new Error("Unsupported photo format");
	const source = await stat(input);
	if (!source.isFile() || source.size > 100 * 1024 * 1024)
		throw new Error("Choose a photo smaller than 100 MB");
	const hash = createHash("sha256").update(
		// The frame joins the key only when there is one: older clips keep their cache.
		JSON.stringify({ step: "image-clip", version: 1, duration, ...(frame ? { frame } : {}) }),
	);
	for await (const chunk of createReadStream(input)) hash.update(chunk);
	await mkdir(cacheDir, { recursive: true });
	const output = path.join(cacheDir, hash.digest("hex") + ".mp4");
	if (
		await stat(output)
			.then((s) => s.size > 0)
			.catch(() => false)
	)
		return output;
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg)
		throw new Error(
			"Photo import requires the bundled FFmpeg. Run the Donqui Studio runtime setup first.",
		);
	const temporary = path.join(cacheDir, randomUUID() + ".tmp.mp4");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(ffmpeg, imageClipArgs(input, duration, temporary, frame), {
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(
				() => {
					timedOut = true;
					child.kill();
				},
				60 * 60 * 1000,
			);
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + String(chunk)).slice(-8192);
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && !timedOut) resolve();
				else
					reject(
						new Error(
							timedOut
								? "Photo conversion timed out after 60 minutes"
								: "Photo conversion failed: " + stderr,
						),
					);
			});
		});
		if ((await stat(temporary)).size === 0)
			throw new Error("Photo conversion produced an empty file");
		await rename(temporary, output);
		return output;
	} finally {
		await rm(temporary, { force: true });
	}
}
