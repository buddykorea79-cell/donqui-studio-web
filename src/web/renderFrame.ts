import type { WebClip } from "./project";

export function frameTransform(effect: WebClip["effect"], time: number, duration: number) {
	const progress = Math.max(0, Math.min(1, time / Math.max(duration, 0.001)));
	const scale =
		effect === "zoom-in" ? 1 + 0.15 * progress : effect === "zoom-out" ? 1.15 - 0.15 * progress : 1;
	const fadeSeconds = Math.min(0.5, duration / 2);
	const opacity =
		effect === "fade"
			? Math.max(0, Math.min(1, time / fadeSeconds, (duration - time) / fadeSeconds))
			: 1;
	return { scale, opacity };
}

function sourceDimensions(source: CanvasImageSource): { width: number; height: number } {
	if ("videoWidth" in source) return { width: source.videoWidth, height: source.videoHeight };
	if ("naturalWidth" in source) return { width: source.naturalWidth, height: source.naturalHeight };
	if ("displayWidth" in source) return { width: source.displayWidth, height: source.displayHeight };
	return { width: Number(source.width), height: Number(source.height) };
}

/** Preview and export share this renderer so effects and captions occupy the same pixels. */
export function drawFrame(
	context: CanvasRenderingContext2D,
	source: CanvasImageSource | null,
	clip: WebClip | null,
	width: number,
	height: number,
	localTime: number,
): void {
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalAlpha = 1;
	context.fillStyle = "#090b0e";
	context.fillRect(0, 0, width, height);
	if (source && clip) {
		const size = sourceDimensions(source);
		const { scale, opacity } = frameTransform(clip.effect, localTime, clip.duration);
		if (size.width > 0 && size.height > 0) {
			const fit = Math.min(width / size.width, height / size.height) * scale;
			const drawWidth = size.width * fit;
			const drawHeight = size.height * fit;
			context.globalAlpha = opacity;
			context.drawImage(
				source,
				(width - drawWidth) / 2,
				(height - drawHeight) / 2,
				drawWidth,
				drawHeight,
			);
		}
		context.globalAlpha = 1;
		if (clip.caption.trim()) drawCaption(context, clip.caption, width, height);
	}
	context.restore();
}

function drawCaption(
	context: CanvasRenderingContext2D,
	text: string,
	width: number,
	height: number,
) {
	const fontSize = Math.max(14, Math.round(height * 0.042));
	const padding = fontSize * 0.5;
	const lineHeight = fontSize * 1.45;
	context.font = `600 ${fontSize}px system-ui, sans-serif`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const character of paragraph) {
			if (line && context.measureText(line + character).width > width * 0.84) {
				lines.push(line);
				line = character;
			} else line += character;
		}
		lines.push(line);
	}
	const visible = lines.slice(0, Math.max(1, Math.floor((height * 0.8) / lineHeight)));
	const bottom = height * 0.92;
	const boxWidth = Math.min(
		width * 0.9,
		Math.max(...visible.map((line) => context.measureText(line).width)) + padding * 2,
	);
	context.fillStyle = "rgba(0,0,0,0.68)";
	context.fillRect(
		(width - boxWidth) / 2,
		bottom - visible.length * lineHeight - padding,
		boxWidth,
		visible.length * lineHeight + padding * 2,
	);
	context.fillStyle = "#ffffff";
	visible.forEach((line, index) => {
		context.fillText(line, width / 2, bottom - (visible.length - index - 0.5) * lineHeight);
	});
}
