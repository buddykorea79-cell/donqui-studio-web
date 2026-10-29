import { z } from "zod";
import { validateWorkspace, type WebWorkspace } from "./project";

const MAGIC = new TextEncoder().encode("DONQUI-WEB\n");
const PREFIX_LENGTH = MAGIC.length + 4;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const headerSchema = z.object({
	version: z.literal(1),
	project: z.unknown(),
	assets: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				kind: z.enum(["video", "image", "audio"]),
				duration: z.number(),
				width: z.number().optional(),
				height: z.number().optional(),
				type: z.string().max(256),
				size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
			}),
		)
		.max(10_000),
});

/** A small JSON header followed by original blobs; no base64 or full-media buffer copies. */
export function encodeWorkspace(workspace: WebWorkspace): Blob {
	const valid = validateWorkspace(workspace);
	const header = new TextEncoder().encode(
		JSON.stringify({
			version: 1,
			project: valid.project,
			assets: valid.assets.map(({ blob, ...asset }) => ({
				...asset,
				type: blob.type,
				size: blob.size,
			})),
		}),
	);
	if (header.byteLength > MAX_HEADER_BYTES) throw new Error("프로젝트 정보가 너무 큽니다.");
	const prefix = new Uint8Array(PREFIX_LENGTH);
	prefix.set(MAGIC);
	new DataView(prefix.buffer).setUint32(MAGIC.length, header.byteLength, true);
	return new Blob([prefix, header, ...valid.assets.map((asset) => asset.blob)], {
		type: "application/x-donqui-project",
	});
}

export async function decodeWorkspace(blob: Blob): Promise<WebWorkspace> {
	if (blob.size < PREFIX_LENGTH) throw new Error("Donqui 웹 프로젝트 파일이 아닙니다.");
	const prefix = new Uint8Array(await blob.slice(0, PREFIX_LENGTH).arrayBuffer());
	if (!MAGIC.every((byte, index) => prefix[index] === byte)) {
		throw new Error("Donqui 웹 프로젝트 파일이 아닙니다.");
	}
	const headerLength = new DataView(prefix.buffer).getUint32(MAGIC.length, true);
	if (
		headerLength === 0 ||
		headerLength > MAX_HEADER_BYTES ||
		headerLength > blob.size - PREFIX_LENGTH
	) {
		throw new Error("프로젝트 파일의 정보가 손상되었거나 잘렸습니다.");
	}
	const headerBytes = await blob.slice(PREFIX_LENGTH, PREFIX_LENGTH + headerLength).arrayBuffer();
	let rawHeader: unknown;
	try {
		rawHeader = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
	} catch {
		throw new Error("프로젝트 정보를 읽을 수 없습니다.");
	}
	const parsed = headerSchema.safeParse(rawHeader);
	if (!parsed.success) throw new Error("지원하지 않거나 손상된 프로젝트 형식입니다.");
	let offset = PREFIX_LENGTH + headerLength;
	const assets = parsed.data.assets.map(({ size, type, ...asset }) => {
		if (size > blob.size - offset) throw new Error("프로젝트 원본 미디어가 잘렸습니다.");
		const media = blob.slice(offset, offset + size, type);
		offset += size;
		return { ...asset, blob: media };
	});
	if (offset !== blob.size) throw new Error("프로젝트 파일의 크기가 정보와 일치하지 않습니다.");
	return validateWorkspace({ project: parsed.data.project, assets });
}
