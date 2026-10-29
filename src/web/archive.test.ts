import { describe, expect, it } from "vitest";
import { decodeWorkspace, encodeWorkspace } from "./archive";
import { createClip, createProject, type WebWorkspace } from "./project";

function workspace(): WebWorkspace {
	const image = {
		id: "image-1",
		name: "여행.jpg",
		kind: "image" as const,
		duration: 0,
		width: 1920,
		height: 1080,
		blob: new Blob([new Uint8Array([0, 1, 2, 255])], { type: "image/jpeg" }),
	};
	return {
		project: { ...createProject(), title: "가을 여행", clips: [createClip(image)] },
		assets: [image],
	};
}

async function changeHeader(blob: Blob, mutate: (header: Record<string, unknown>) => void) {
	const original = new Uint8Array(await blob.arrayBuffer());
	const magicLength = "DONQUI-WEB\n".length;
	const prefixLength = magicLength + 4;
	const length = new DataView(original.buffer).getUint32(magicLength, true);
	const header = JSON.parse(
		new TextDecoder().decode(original.slice(prefixLength, prefixLength + length)),
	) as Record<string, unknown>;
	mutate(header);
	const changed = new TextEncoder().encode(JSON.stringify(header));
	const prefix = original.slice(0, prefixLength);
	new DataView(prefix.buffer).setUint32(magicLength, changed.byteLength, true);
	return new Blob([prefix, changed, original.slice(prefixLength + length)]);
}

describe("portable Donqui web projects", () => {
	it("round-trips timeline, Unicode names and exact original media bytes", async () => {
		const original = workspace();
		const decoded = await decodeWorkspace(encodeWorkspace(original));
		expect(decoded.project).toEqual(original.project);
		expect(decoded.assets[0].name).toBe("여행.jpg");
		expect(decoded.assets[0].blob.type).toBe("image/jpeg");
		expect(await decoded.assets[0].blob.arrayBuffer()).toEqual(
			await original.assets[0].blob.arrayBuffer(),
		);
	});

	it("supports an empty project backup", async () => {
		const original = { project: createProject(), assets: [] };
		expect(await decodeWorkspace(encodeWorkspace(original))).toEqual(original);
	});

	it("rejects unknown files, truncated metadata and truncated media", async () => {
		await expect(decodeWorkspace(new Blob(["not a project file"]))).rejects.toThrow();
		const archive = encodeWorkspace(workspace());
		await expect(decodeWorkspace(archive.slice(0, 20))).rejects.toThrow("정보가 손상");
		await expect(decodeWorkspace(archive.slice(0, archive.size - 1))).rejects.toThrow(
			"미디어가 잘렸",
		);
		await expect(decodeWorkspace(new Blob([archive, "extra"]))).rejects.toThrow("크기가");
	});

	it("rejects unsupported versions and missing media references", async () => {
		const archive = encodeWorkspace(workspace());
		const unsupported = await changeHeader(archive, (header) => {
			header.version = 99;
		});
		await expect(decodeWorkspace(unsupported)).rejects.toThrow("지원하지 않거나");
		const missingMedia = await changeHeader(archive, (header) => {
			const project = header.project as WebWorkspace["project"];
			project.clips[0].assetId = "missing";
		});
		await expect(decodeWorkspace(missingMedia)).rejects.toThrow("원본 미디어");
	});

	it("rejects an unreasonable header length before reading it", async () => {
		const data = new Uint8Array(await encodeWorkspace(workspace()).arrayBuffer());
		new DataView(data.buffer).setUint32("DONQUI-WEB\n".length, 0xffffffff, true);
		await expect(decodeWorkspace(new Blob([data]))).rejects.toThrow("정보가 손상");
	});
});
