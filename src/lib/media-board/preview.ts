import { create } from "zustand";

/**
 * Media's playhead, shared by its preview and its timeline. The preview's player owns the clock
 * while it plays and reports each frame here; the timeline asks it to seek through `seekTo`.
 * Media keeps a clock of its own because its time is the composition's, not Edit's timeline's.
 */

export interface MediaPreviewControls {
	seek: (sec: number) => void;
	toggle: () => void;
	pause: () => void;
}

interface MediaPreviewState {
	timeSec: number;
	playing: boolean;
	controls: MediaPreviewControls | null;
	setTime: (sec: number) => void;
	setPlaying: (playing: boolean) => void;
	attach: (controls: MediaPreviewControls | null) => void;
	/** Moves the playhead, and the preview with it when there is one. */
	seekTo: (sec: number) => void;
	toggle: () => void;
}

export const useMediaPreview = create<MediaPreviewState>((set, get) => ({
	timeSec: 0,
	playing: false,
	controls: null,
	setTime: (sec) => {
		const timeSec = Number.isFinite(sec) ? Math.max(0, sec) : 0;
		if (timeSec !== get().timeSec) set({ timeSec });
	},
	setPlaying: (playing) => {
		if (playing !== get().playing) set({ playing });
	},
	attach: (controls) => set({ controls, ...(controls ? {} : { playing: false }) }),
	seekTo: (sec) => {
		get().setTime(sec);
		get().controls?.seek(get().timeSec);
	},
	toggle: () => get().controls?.toggle(),
}));
