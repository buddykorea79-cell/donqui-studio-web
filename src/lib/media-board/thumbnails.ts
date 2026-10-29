import { useEffect, useState } from "react";

/**
 * Card thumbnails of a video at a given time, read by FFmpeg in the main process (camera
 * footage is often a codec the browser cannot decode) and kept for the session. A failure is
 * not kept, so a card asks again the next time it mounts.
 */

const cache = new Map<string, Promise<string | null>>();

export function loadThumbnail(sourcePath: string, atSec: number): Promise<string | null> {
	const at = Math.round(Math.max(0, atSec) * 10) / 10;
	const key = `${sourcePath}\n${at}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const request = window.electronAPI?.vclipThumbnail;
	const pending = request
		? request(sourcePath, at)
				.then((result) => (result.success && result.dataUrl ? result.dataUrl : null))
				.catch(() => null)
		: Promise.resolve(null);
	cache.set(key, pending);
	void pending.then((url) => {
		if (!url) cache.delete(key);
	});
	return pending;
}

export function useThumbnail(sourcePath: string | null, atSec: number): string | null {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!sourcePath) {
			setUrl(null);
			return;
		}
		let active = true;
		void loadThumbnail(sourcePath, atSec).then((next) => {
			if (active) setUrl(next);
		});
		return () => {
			active = false;
		};
	}, [sourcePath, atSec]);
	return url;
}
