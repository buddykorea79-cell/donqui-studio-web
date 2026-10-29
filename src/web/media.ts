import type { WebAsset } from "./project";

export function assetKind(file: Pick<File, "name" | "type">): WebAsset["kind"] {
	if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(file.name))
		return "image";
	if (file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name))
		return "audio";
	if (file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name))
		return "video";
	throw new Error(`${file.name}: 지원하는 사진·영상·음원 파일을 선택해 주세요.`);
}

export async function importMedia(file: File): Promise<WebAsset> {
	if (!file.size) throw new Error(`${file.name}: 빈 파일입니다.`);
	const kind = assetKind(file);
	const base = { id: crypto.randomUUID(), name: file.name, kind, blob: file };
	if (kind !== "image") {
		const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
		const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
		try {
			const duration = await input.computeDuration();
			if (!Number.isFinite(duration) || duration <= 0)
				throw new Error("재생 시간을 읽을 수 없습니다.");
			if (kind === "audio") {
				const track = await input.getPrimaryAudioTrack();
				if (!track || !(await track.canDecode()))
					throw new Error("오디오를 읽을 수 없습니다. WAV 또는 MP3 파일을 사용해 주세요.");
				return { ...base, duration };
			}
			const track = await input.getPrimaryVideoTrack();
			if (!track || !(await track.canDecode()))
				throw new Error(
					"이 브라우저에서 영상 코덱을 읽을 수 없습니다. H.264 MP4 또는 WebM으로 변환해 주세요.",
				);
			return { ...base, duration, width: track.displayWidth, height: track.displayHeight };
		} catch (error) {
			throw new Error(
				`${file.name}: ${error instanceof Error ? error.message : "미디어를 읽을 수 없습니다."}`,
			);
		} finally {
			input.dispose();
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		return { ...base, duration: 5, width: image.naturalWidth, height: image.naturalHeight };
	} finally {
		URL.revokeObjectURL(url);
	}
}

export function downloadBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = Array.from(name, (character) =>
		character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character,
	).join("");
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Give the browser time to hand the blob to its download manager.
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatTime(seconds: number) {
	const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
	const tenths = Math.floor(value * 10 + 1e-7);
	return `${Math.floor(tenths / 600)
		.toString()
		.padStart(2, "0")}:${Math.floor((tenths % 600) / 10)
		.toString()
		.padStart(2, "0")}.${tenths % 10}`;
}
