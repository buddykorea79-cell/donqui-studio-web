import { toast } from "sonner";
import { create } from "zustand";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import {
	boardOf,
	type ClipDraft,
	removeBoardClip,
	upsertBoardClips,
} from "@/lib/media-board/board";
import { mutateDocument } from "@/lib/media-board/mutate";
import {
	VCLIP_SEGMENT_LIMITS,
	type VClipProbeResult,
	type VClipWindowAnalysis,
	type VClipWindowResult,
} from "./contract";
import {
	candidateWindows,
	clampSegmentRange,
	clampSegmentSec,
	mergeAnalysis,
	nextManualRange,
	provisionalSegments,
	selectionToFill,
	type VClipSegment,
	type VClipWindow,
} from "./segments";
import { effectiveModel, useVisionModelStore } from "./visionModels";

/**
 * V.Clip's working state: every source video's segments — found by analysis, added by hand,
 * or restored from the clips already split — and one analysis queue that works through the
 * videos one after another, the way AutoVeo analyses a whole folder. It lives outside the
 * stage so a run keeps going, and its results stay, while the user looks at another tab.
 * State is keyed by project and asset; a run stops itself when the project changes under it.
 *
 * V.Clip only splits. A split clip is a range of its source in the project's media board —
 * nothing is rendered here; Media adds effects when it composes clips onto the timeline.
 */

export type VClipSource = Pick<AxcutAsset, "id" | "label" | "originalPath">;

export interface VClipRun {
	jobId: string | null;
	/** idle: nothing analysed yet, only segments added by hand or restored from the bin. */
	status: "idle" | "queued" | "analyzing" | "done" | "canceled" | "failed";
	/** Windows analysed so far, of `total`. */
	completed: number;
	total: number;
	/** The model the last analysis asked, or null for frame quality alone. */
	model: string | null;
	segments: VClipSegment[];
	/** Windows FFmpeg could not read; the run carries on without them. */
	unreadable: number;
	error: string | null;
}

interface QueuedAnalysis {
	key: string;
	source: VClipSource;
	/** What the run was before it was queued, to go back to if it never starts. */
	previous: VClipRun["status"];
}

interface VClipState {
	/** The source to bring into view — Media's "V.Clip에서 나누기". */
	focusId: string | null;
	/** Length of the windows analysis cuts, and of a segment added by hand. */
	segmentSec: number;
	probes: Record<string, VClipProbeResult>;
	runs: Record<string, VClipRun>;
	queue: QueuedAnalysis[];
	splitting: boolean;

	focusSource: (assetId: string | null) => void;
	setSegmentSec: (value: number) => void;
	probe: (source: VClipSource) => Promise<VClipProbeResult>;
	analyze: (source: VClipSource) => void;
	analyzeAll: (sources: VClipSource[]) => void;
	cancel: (assetId: string) => void;
	cancelAll: () => void;
	toggleSegment: (assetId: string, segmentId: string) => void;
	setSelection: (assetId: string, segmentIds: ReadonlySet<string>) => void;
	selectAll: (assetIds: string[], selected: boolean) => void;
	selectToFill: (assetIds: string[], targetSec: number) => number;
	adjustSegment: (
		assetId: string,
		segmentId: string,
		range: VClipWindow,
		moved?: "start" | "end" | "both",
	) => void;
	/** Every segment `lengthSec` long, from where it starts. */
	resizeAll: (assetIds: string[], lengthSec: number) => void;
	addManualSegment: (source: VClipSource) => void;
	removeSegment: (assetId: string, segmentId: string) => Promise<void>;
	split: (sources: VClipSource[]) => Promise<number>;
}

const SEGMENT_SEC_KEY = "donqui.vclip.segmentSec";

function readSegmentSec(): number {
	try {
		const stored = Number(localStorage.getItem(SEGMENT_SEC_KEY));
		return stored ? clampSegmentSec(stored) : VCLIP_SEGMENT_LIMITS.defaultSec;
	} catch {
		return VCLIP_SEGMENT_LIMITS.defaultSec;
	}
}

export function vclipKey(projectId: string | null, assetId: string): string {
	return `${projectId ?? ""}:${assetId}`;
}

function currentKey(assetId: string): string | null {
	const projectId = useProjectStore.getState().projectId;
	return projectId ? vclipKey(projectId, assetId) : null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The bin clips of one source, as V.Clip segments that are already split. */
function binSegments(document: AxcutDocument | null, assetId: string): VClipSegment[] {
	return boardOf(document)
		.clips.filter((clip) => clip.assetId === assetId)
		.map((clip) => ({
			id: `bin:${clip.id}`,
			startSec: clip.startSec,
			endSec: clip.endSec,
			selected: false,
			origin: "bin" as const,
			analysis: null,
			clipId: clip.id,
		}))
		.sort((left, right) => left.startSec - right.startSec);
}

function idleRun(segments: VClipSegment[]): VClipRun {
	return {
		jobId: null,
		status: "idle",
		completed: 0,
		total: 0,
		model: null,
		segments,
		unreadable: 0,
		error: null,
	};
}

/** Whether a segment's clip in the bin still is what the segment says. */
export function segmentIsSplit(segment: VClipSegment, document: AxcutDocument | null): boolean {
	if (!segment.clipId) return false;
	const clip = boardOf(document).clips.find((entry) => entry.id === segment.clipId);
	return Boolean(
		clip &&
			Math.abs(clip.startSec - segment.startSec) < 0.005 &&
			Math.abs(clip.endSec - segment.endSec) < 0.005,
	);
}

/** The bin clip's name: where it comes from, and when. */
export function clipLabel(source: Pick<VClipSource, "label">, range: VClipWindow): string {
	return `${source.label} · ${formatSec(range.startSec)}–${formatSec(range.endSec)}`;
}

/**
 * What an analysis leaves alone: segments added by hand, restored from the bin or split into
 * a clip. The other found windows are found again by the next run.
 */
function isKept(segment: VClipSegment): boolean {
	return segment.origin !== "auto" || segment.clipId !== null;
}

function keptSegments(segments: VClipSegment[]): VClipSegment[] {
	return segments.filter(isKept);
}

/** A found window still being analysed: re-ranked when the run ends, so not yet the user's. */
export function isProvisional(segment: VClipSegment, run: Pick<VClipRun, "status">): boolean {
	return run.status === "analyzing" && !isKept(segment);
}

function clipNote(analysis: VClipWindowAnalysis | null): string | undefined {
	return analysis?.ai?.caption || analysis?.ai?.description || undefined;
}

export const useVClipStore = create<VClipState>((set, get) => {
	/** Updates one run, if it is still there. */
	const patch = (key: string, update: (run: VClipRun) => Partial<VClipRun>) =>
		set((state) => {
			const run = state.runs[key];
			return run ? { runs: { ...state.runs, [key]: { ...run, ...update(run) } } } : {};
		});

	/** The run of a source in the open project, made from the bin when there is none yet. */
	const ensureRun = (assetId: string): string | null => {
		const key = currentKey(assetId);
		if (!key) return null;
		if (!get().runs[key])
			set((state) => ({
				runs: {
					...state.runs,
					[key]: idleRun(binSegments(useProjectStore.getState().document, assetId)),
				},
			}));
		return key;
	};

	const updateSegments = (
		assetId: string,
		update: (segments: VClipSegment[]) => VClipSegment[],
	) => {
		const key = ensureRun(assetId);
		if (key) patch(key, (run) => ({ segments: update(run.segments) }));
	};

	/** Stores what FFmpeg read into the asset when the project does not know it yet. */
	const recordProbe = (assetId: string, probe: VClipProbeResult) => {
		if (!probe.success || !probe.durationSec) return;
		const durationSec = probe.durationSec;
		const asset = useProjectStore.getState().document?.assets.find((item) => item.id === assetId);
		const missingSize = !asset?.video?.width || !asset.video.height;
		if (!asset || (asset.durationSec && !missingSize)) return;
		void mutateDocument(
			(document) => ({
				...document,
				assets: document.assets.map((item) =>
					item.id !== assetId
						? item
						: {
								...item,
								durationSec: item.durationSec || durationSec,
								...(missingSize && probe.width && probe.height
									? {
											video: {
												codec: item.video?.codec ?? "unknown",
												fps: item.video?.fps || probe.fps || 0,
												width: probe.width,
												height: probe.height,
											},
										}
									: {}),
							},
				),
			}),
			// A fact read off the file, not something the user did: nothing to undo.
			{ history: false },
		).catch(() => undefined);
	};

	let pumping = false;
	/** Works through the queue, one source at a time. */
	const pump = async () => {
		if (pumping) return;
		pumping = true;
		try {
			for (;;) {
				const next = get().queue[0];
				if (!next) break;
				set((state) => ({ queue: state.queue.slice(1) }));
				// Queued in a project that is no longer open: it would wait there forever.
				if (currentKey(next.source.id) !== next.key) {
					patch(next.key, () => ({ status: next.previous }));
					continue;
				}
				await analyzeNow(next.key, next.source);
			}
		} finally {
			pumping = false;
		}
	};

	/** Ends an analysis, keeping what it found, merged as a finished one would be. */
	const stopRun = (
		key: string,
		analyses: VClipWindowAnalysis[],
		status: VClipRun["status"],
		error: string | null = null,
	) =>
		patch(key, (run) => ({
			status,
			error,
			segments: mergeAnalysis(keptSegments(run.segments), analyses),
		}));

	const analyzeNow = async (key: string, source: VClipSource) => {
		const projectId = useProjectStore.getState().projectId;
		const analyzeWindow = window.electronAPI?.vclipAnalyzeWindow;
		if (!projectId || !get().runs[key]) return;
		if (!analyzeWindow) {
			patch(key, () => ({
				status: "failed",
				error: "V.Clip은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.",
			}));
			return;
		}
		const vision = useVisionModelStore.getState();
		if (!vision.models) await vision.load();
		const { chosen, models } = useVisionModelStore.getState();
		const model = effectiveModel(chosen, models);
		const jobId = crypto.randomUUID();
		patch(key, (run) => ({
			jobId,
			status: "analyzing",
			completed: 0,
			total: 0,
			model,
			segments: keptSegments(run.segments),
			unreadable: 0,
			error: null,
		}));
		const ours = () => {
			const run = get().runs[key];
			return run?.jobId === jobId && run.status === "analyzing";
		};

		const probe = await get().probe(source);
		if (!ours()) return;
		if (!probe.success || !probe.durationSec) {
			stopRun(key, [], "failed", probe.error || "영상 길이를 읽지 못했습니다.");
			return;
		}
		const windows = candidateWindows(probe.durationSec, clampSegmentSec(get().segmentSec));
		patch(key, () => ({ total: windows.length }));

		const analyses: VClipWindowAnalysis[] = [];
		let firstError: string | null = null;
		for (const span of windows) {
			if (useProjectStore.getState().projectId !== projectId) {
				stopRun(key, analyses, "canceled");
				void window.electronAPI?.vclipCancel?.(jobId);
				return;
			}
			const result = await analyzeWindow({
				jobId,
				sourcePath: source.originalPath,
				startSec: span.startSec,
				endSec: span.endSec,
				model,
				title: source.label,
			}).catch((error: unknown): VClipWindowResult => ({ success: false, error: message(error) }));
			if (!ours()) return;
			if (result.success && result.result) analyses.push(result.result);
			else firstError ??= result.error ?? "구간을 읽지 못했습니다.";
			patch(key, (run) => ({
				completed: run.completed + 1,
				unreadable: run.unreadable + (result.success ? 0 : 1),
				segments: [...keptSegments(run.segments), ...provisionalSegments(analyses)].sort(
					(left, right) => left.startSec - right.startSec,
				),
			}));
		}
		if (analyses.length === 0) stopRun(key, analyses, "failed", firstError);
		else stopRun(key, analyses, "done");
	};

	const enqueue = (sources: VClipSource[]) => {
		const added: QueuedAnalysis[] = [];
		for (const source of sources) {
			const key = ensureRun(source.id);
			if (!key) continue;
			const run = get().runs[key];
			if (run.status === "analyzing" || run.status === "queued") continue;
			patch(key, () => ({ status: "queued" }));
			added.push({ key, source, previous: run.status });
		}
		if (added.length === 0) return;
		set((state) => ({ queue: [...state.queue, ...added] }));
		void pump();
	};

	return {
		focusId: null,
		segmentSec: readSegmentSec(),
		probes: {},
		runs: {},
		queue: [],
		splitting: false,

		focusSource: (assetId) => set({ focusId: assetId }),

		setSegmentSec(value) {
			set({ segmentSec: value });
			if (Number.isFinite(value) && value >= VCLIP_SEGMENT_LIMITS.minSec)
				try {
					localStorage.setItem(SEGMENT_SEC_KEY, String(clampSegmentSec(value)));
				} catch {
					// A preference only.
				}
		},

		async probe(source) {
			const key = currentKey(source.id);
			const cached = key ? get().probes[key] : undefined;
			if (cached?.success) return cached;
			const probe = window.electronAPI?.vclipProbe;
			const result: VClipProbeResult = probe
				? await probe(source.originalPath).catch(
						(error: unknown): VClipProbeResult => ({ success: false, error: message(error) }),
					)
				: { success: false, error: "V.Clip은 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다." };
			if (key && currentKey(source.id) === key) {
				set((state) => ({ probes: { ...state.probes, [key]: result } }));
				recordProbe(source.id, result);
			}
			return result;
		},

		analyze: (source) => enqueue([source]),
		analyzeAll: (sources) => enqueue(sources),

		cancel(assetId) {
			const key = currentKey(assetId);
			const run = key ? get().runs[key] : undefined;
			if (!key || !run) return;
			if (run.status === "queued") {
				const entry = get().queue.find((queued) => queued.key === key);
				set((state) => ({ queue: state.queue.filter((queued) => queued.key !== key) }));
				patch(key, () => ({ status: entry?.previous ?? "idle" }));
				return;
			}
			if (run.status !== "analyzing") return;
			const analyses = run.segments
				.filter((segment) => !isKept(segment))
				.flatMap((segment) => (segment.analysis ? [segment.analysis] : []));
			stopRun(key, analyses, "canceled");
			if (run.jobId) void window.electronAPI?.vclipCancel?.(run.jobId);
		},

		cancelAll() {
			const prefix = vclipKey(useProjectStore.getState().projectId, "");
			for (const entry of get().queue) get().cancel(entry.source.id);
			for (const [key, run] of Object.entries(get().runs))
				if (run.status === "analyzing" && key.startsWith(prefix))
					get().cancel(key.slice(prefix.length));
		},

		toggleSegment(assetId, segmentId) {
			updateSegments(assetId, (segments) =>
				segments.map((segment) =>
					segment.id === segmentId ? { ...segment, selected: !segment.selected } : segment,
				),
			);
		},

		setSelection(assetId, segmentIds) {
			updateSegments(assetId, (segments) =>
				segments.map((segment) => ({ ...segment, selected: segmentIds.has(segment.id) })),
			);
		},

		selectAll(assetIds, selected) {
			const document = useProjectStore.getState().document;
			for (const assetId of assetIds)
				updateSegments(assetId, (segments) =>
					segments.map((segment) => ({
						...segment,
						// A clip that is split and unchanged has nothing left to do.
						selected: selected && !segmentIsSplit(segment, document),
					})),
				);
		},

		selectToFill(assetIds, targetSec) {
			const document = useProjectStore.getState().document;
			const candidates: VClipSegment[] = [];
			for (const assetId of assetIds) {
				const key = ensureRun(assetId);
				const run = key ? get().runs[key] : undefined;
				for (const segment of run?.segments ?? [])
					if (!segmentIsSplit(segment, document))
						candidates.push({ ...segment, id: `${assetId}\n${segment.id}` });
			}
			const picked = selectionToFill(candidates, targetSec);
			for (const assetId of assetIds)
				updateSegments(assetId, (segments) =>
					segments.map((segment) => ({
						...segment,
						selected: picked.has(`${assetId}\n${segment.id}`),
					})),
				);
			return picked.size;
		},

		adjustSegment(assetId, segmentId, range, moved = "both") {
			const key = currentKey(assetId);
			const duration = key ? get().probes[key]?.durationSec : undefined;
			const next = clampSegmentRange(range, duration, moved);
			const document = useProjectStore.getState().document;
			updateSegments(assetId, (segments) =>
				segments.map((segment) => {
					if (segment.id !== segmentId) return segment;
					const adjusted = { ...segment, ...next };
					// A split clip that no longer matches waits to be split again.
					return segment.clipId && !segmentIsSplit(adjusted, document)
						? { ...adjusted, selected: true }
						: adjusted;
				}),
			);
		},

		resizeAll(assetIds, lengthSec) {
			const length = clampSegmentSec(lengthSec);
			const document = useProjectStore.getState().document;
			for (const assetId of assetIds) {
				const key = currentKey(assetId);
				const duration = key ? get().probes[key]?.durationSec : undefined;
				updateSegments(assetId, (segments) =>
					segments.map((segment) => {
						const startSec =
							duration && segment.startSec + length > duration
								? Math.max(0, duration - length)
								: segment.startSec;
						const adjusted = {
							...segment,
							...clampSegmentRange({ startSec, endSec: startSec + length }, duration, "end"),
						};
						return segment.clipId && !segmentIsSplit(adjusted, document)
							? { ...adjusted, selected: true }
							: adjusted;
					}),
				);
			}
		},

		addManualSegment(source) {
			const key = ensureRun(source.id);
			const duration = key ? get().probes[key]?.durationSec : undefined;
			if (!key || !duration) return;
			const run = get().runs[key];
			const range = nextManualRange(run.segments, duration, clampSegmentSec(get().segmentSec));
			patch(key, (current) => ({
				segments: [
					...current.segments,
					{
						id: crypto.randomUUID(),
						...range,
						selected: true,
						origin: "manual" as const,
						analysis: null,
						clipId: null,
					},
				].sort((left, right) => left.startSec - right.startSec),
			}));
		},

		async removeSegment(assetId, segmentId) {
			const key = currentKey(assetId);
			const segment = key ? get().runs[key]?.segments.find((item) => item.id === segmentId) : null;
			if (!key || !segment) return;
			// A split segment takes its clip out of the bin with it.
			if (segment.clipId) {
				const clipId = segment.clipId;
				const document = useProjectStore.getState().document;
				if (boardOf(document).clips.some((clip) => clip.id === clipId))
					await mutateDocument((current) => removeBoardClip(current, clipId), { history: true });
			}
			patch(key, (run) => ({ segments: run.segments.filter((item) => item.id !== segmentId) }));
		},

		async split(sources) {
			const projectId = useProjectStore.getState().projectId;
			if (!projectId || get().splitting) return 0;
			const document = useProjectStore.getState().document;
			const work: Array<{ key: string; source: VClipSource; segment: VClipSegment }> = [];
			for (const source of sources) {
				const key = vclipKey(projectId, source.id);
				for (const segment of get().runs[key]?.segments ?? [])
					if (segment.selected && !segmentIsSplit(segment, document))
						work.push({ key, source, segment });
			}
			if (work.length === 0) return 0;
			set({ splitting: true });
			const epoch = currentWriteEpoch();
			let ids: string[] = [];
			try {
				const saved = await enqueueDocumentWrite(async () => {
					const state = useProjectStore.getState();
					if (!state.document || state.projectId !== projectId || currentWriteEpoch() !== epoch)
						return false;
					const existing = new Set(boardOf(state.document).clips.map((clip) => clip.id));
					const drafts: ClipDraft[] = work.map(({ source, segment }) => ({
						id: segment.clipId && existing.has(segment.clipId) ? segment.clipId : undefined,
						assetId: source.id,
						startSec: segment.startSec,
						endSec: segment.endSec,
						label: clipLabel(source, segment),
						score: segment.analysis?.score,
						note: clipNote(segment.analysis),
					}));
					const result = upsertBoardClips(state.document, drafts);
					ids = result.ids;
					return state.saveDocument(result.document, { history: true });
				});
				if (!saved) return 0;
				const madeBy = new Map(
					work.map(({ key, segment }, index) => [`${key}\n${segment.id}`, ids[index]]),
				);
				for (const key of new Set(work.map((entry) => entry.key)))
					patch(key, (run) => ({
						segments: run.segments.map((segment) => {
							const clipId = madeBy.get(`${key}\n${segment.id}`);
							return clipId ? { ...segment, clipId, selected: false } : segment;
						}),
					}));
				toast.success(`클립 ${work.length}개를 나눴습니다. Media에서 영상·사진과 조합하세요.`);
				return work.length;
			} catch (error) {
				toast.error("클립을 나누지 못했습니다.", { description: message(error) });
				return 0;
			} finally {
				set({ splitting: false });
			}
		},
	};
});
