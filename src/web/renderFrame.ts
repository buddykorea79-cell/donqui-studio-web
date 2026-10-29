import { CLIP_EFFECT_FPS } from "../lib/clip-effects/catalog";
import { clipEffectTransform } from "../lib/clip-effects/motion";
import { drawCaptionOverlay } from "./captionRender";
import { activeCaptionText, type WebCaption, type WebCaptionStyle } from "./captions";
import type { WebClip } from "./project";
import { getClipOutputDuration, getZoomTransform } from "./timelineEffects";

export function frameTransform(effect: WebClip["effect"], time: number, duration: number) {
	return clipEffectTransform(
		effect,
		Math.floor(time * CLIP_EFFECT_FPS + 1e-7),
		Math.max(1, Math.round(duration * CLIP_EFFECT_FPS)),
		CLIP_EFFECT_FPS,
	);
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
	options: { captions?: WebCaption[]; captionStyle?: WebCaptionStyle; timelineTime?: number } = {},
): void {
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalAlpha = 1;
	context.fillStyle = "#090b0e";
	context.fillRect(0, 0, width, height);
	if (source && clip) {
		const size = sourceDimensions(source);
		const motion = frameTransform(clip.effect, localTime, getClipOutputDuration(clip));
		const zoom = getZoomTransform(clip, localTime);
		if (size.width > 0 && size.height > 0) {
			context.save();
			// Clamp the zoom camera to the frame edges, then apply the existing clip motion.
			if (zoom.scale !== 1) {
				const focusX = Math.max(0.5 / zoom.scale, Math.min(1 - 0.5 / zoom.scale, zoom.focusX));
				const focusY = Math.max(0.5 / zoom.scale, Math.min(1 - 0.5 / zoom.scale, zoom.focusY));
				context.translate(
					width / 2 - focusX * width * zoom.scale,
					height / 2 - focusY * height * zoom.scale,
				);
				context.scale(zoom.scale, zoom.scale);
			}
			context.translate(
				width / 2 + (motion.translateX * width) / 100,
				height / 2 + (motion.translateY * height) / 100,
			);
			context.rotate((motion.rotation * Math.PI) / 180);
			context.scale(motion.scale, motion.scale);
			context.globalAlpha = motion.opacity;
			if (clip.fit === "cover") {
				// CSS object-fit crops inside the media element before the outer effect transforms it.
				const ratio = Math.max(width / size.width, height / size.height);
				const cropWidth = width / ratio;
				const cropHeight = height / ratio;
				context.drawImage(
					source,
					(size.width - cropWidth) / 2,
					(size.height - cropHeight) / 2,
					cropWidth,
					cropHeight,
					-width / 2,
					-height / 2,
					width,
					height,
				);
			} else {
				const ratio = Math.min(width / size.width, height / size.height);
				const drawWidth = size.width * ratio;
				const drawHeight = size.height * ratio;
				context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
			}
			context.restore();
		}
	}
	const captionText = [
		clip?.caption ?? "",
		activeCaptionText(options.captions ?? [], options.timelineTime ?? localTime),
	]
		.filter((text) => text.trim())
		.join("\n");
	drawCaptionOverlay(context, captionText, width, height, options.captionStyle);
	context.restore();
}
