import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export function parseMediaRange(
	value: string,
	size: number,
): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!match || (!match[1] && !match[2])) return null;
	const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	)
		return null;
	return { start, end };
}

const CONTENT_TYPES: Record<string, string> = {
	".webm": "video/webm",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/** What the headless browser is told the file is; any other container plays as MP4. */
export function clipSourceContentType(sourcePath: string): string {
	return CONTENT_TYPES[path.extname(sourcePath).toLowerCase()] ?? "video/mp4";
}

/** A short-lived loopback server exposing exactly one approved file, with video seeking. */
export async function serveClipSource(sourcePath: string) {
	const { size } = await stat(sourcePath);
	const route = `/${randomUUID()}/source${path.extname(sourcePath).toLowerCase()}`;
	const server = createServer((request, response) => {
		if (request.url !== route || (request.method !== "GET" && request.method !== "HEAD")) {
			response.writeHead(404).end();
			return;
		}
		const range = request.headers.range ? parseMediaRange(request.headers.range, size) : null;
		if (request.headers.range && !range) {
			response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
			return;
		}
		const start = range?.start ?? 0;
		const end = range?.end ?? size - 1;
		response.writeHead(range ? 206 : 200, {
			"Access-Control-Allow-Origin": "*",
			"Accept-Ranges": "bytes",
			"Content-Length": end - start + 1,
			"Content-Type": clipSourceContentType(sourcePath),
			"Cache-Control": "no-store",
			...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		const stream = createReadStream(sourcePath, { start, end });
		stream.on("error", () => response.destroy());
		response.on("close", () => stream.destroy());
		stream.pipe(response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Cannot start clip source server");
	return {
		sourceUrl: `http://127.0.0.1:${address.port}${route}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
