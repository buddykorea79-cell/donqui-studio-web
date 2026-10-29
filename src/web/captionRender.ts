import { DEFAULT_CAPTION_STYLE, type WebCaptionStyle } from "./captions";

/** Draw on the output frame after media transforms, so subtitles remain readable and still. */
export function drawCaptionOverlay(
	context: CanvasRenderingContext2D,
	text: string,
	width: number,
	height: number,
	style: WebCaptionStyle = DEFAULT_CAPTION_STYLE,
): void {
	if (!text.trim() || width <= 0 || height <= 0) return;
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalAlpha = 1;
	const fontSize = Math.max(14, Math.round(height * style.fontSize));
	const padding = fontSize * 0.5;
	const lineHeight = fontSize * 1.45;
	context.font = `600 ${fontSize}px system-ui, sans-serif`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	const maxTextWidth = width * 0.84;
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
		let line = "";
		for (const character of paragraph) {
			if (line && context.measureText(line + character).width > maxTextWidth) {
				lines.push(line);
				line = character;
			} else line += character;
		}
		lines.push(line);
	}
	const maxLines = Math.max(1, Math.floor((height * 0.84 - padding * 2) / lineHeight));
	const visible = lines.slice(0, maxLines);
	const boxHeight = visible.length * lineHeight + padding * 2;
	const boxWidth = Math.min(
		width * 0.9,
		Math.max(...visible.map((line) => context.measureText(line).width)) + padding * 2,
	);
	const top =
		style.position === "top"
			? height * 0.08
			: style.position === "center"
				? (height - boxHeight) / 2
				: height * 0.92 - boxHeight;
	if (style.background) {
		context.fillStyle = "rgba(0,0,0,0.68)";
		context.fillRect((width - boxWidth) / 2, top, boxWidth, boxHeight);
	}
	context.fillStyle = style.color;
	visible.forEach((line, index) => {
		context.fillText(line, width / 2, top + padding + (index + 0.5) * lineHeight, maxTextWidth);
	});
	context.restore();
}
