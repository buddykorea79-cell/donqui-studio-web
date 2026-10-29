import {
	FileText,
	Film,
	Image as ImageIcon,
	ListPlus,
	Plus,
	Scissors,
	Search,
	SquarePlus,
	Trash2,
} from "lucide-react";
import { type DragEvent as ReactDragEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import { isModalOpen } from "@/lib/ai-edition/modalGuard";
import type {
	AxcutAsset,
	AxcutMediaBoardClip,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useAssetTranscriptions } from "@/lib/ai-edition/store/transcriptionStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import type { AssetTranscriptionStatus } from "@/lib/ai-edition/transcription/status";
import { mixStatus } from "@/lib/audio-board/board";
import { audioFitSummary } from "@/lib/clip-effects/audioFit";
import { type ClipEffectSelection, isClipEffectId } from "@/lib/clip-effects/catalog";
import { readImageSize } from "@/lib/media-board/apply";
import {
	addBoardImages,
	addBoardItems,
	boardOf,
	clipItem,
	DEFAULT_IMAGE_SEC,
	type ImageDraft,
	imageItem,
	isSourceVideo,
	MAX_IMAGE_SEC,
	MIN_ITEM_SEC,
	moveBoardItem,
	removeBoardClip,
	removeBoardImage,
	removeBoardItem,
	setBoardItemRanges,
	sortedBoardClips,
	updateBoardItem,
	videoItem,
} from "@/lib/media-board/board";
import { fitComposition, narrationPauses, narrationSpeech } from "@/lib/media-board/fit";
import { mutateDocument } from "@/lib/media-board/mutate";
import { useMediaPreview } from "@/lib/media-board/preview";
import { useComposeStore } from "@/lib/media-board/store";
import { useThumbnail } from "@/lib/media-board/thumbnails";
import { duplicateBoardItem, itemStarts, mediaAudioClips } from "@/lib/media-board/timeline";
import { isTextEditingTarget } from "@/lib/shortcuts";
import { useVClipStore, vclipKey } from "@/lib/vclip/store";
import { formatBytes } from "@/utils/formatBytes";
import { TranscriptionStatusDot } from "../TranscriptionStatus";
import { edit, MediaComposition } from "./MediaComposition";
import styles from "./MediaStage.module.css";
import {
	type AudioState,
	type MaterialPayload,
	MEDIA_MATERIAL_MIME,
	MediaTimeline,
} from "./MediaTimeline";
import { MediaTranscriptPanel } from "./MediaTranscriptPanel";

const ASSET_MIME = "application/x-axcut-asset";
const EFFECT_KEY = "donqui.media.defaultEffect";
const PHOTO_SEC_KEY = "donqui.media.photoSec";
const SNAP_KEY = "donqui.media.snapToNarration";

type LibraryTab = "clips" | "photos" | "videos";

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export async function addSelectedAssetToTimeline(
	selected: Pick<AxcutAsset, "id" | "label" | "originalPath"> | null,
	onAddToTimeline: (assetId: string) => Promise<void>,
	onSuccess: (label: string) => void,
): Promise<void> {
	if (!selected) return;
	await onAddToTimeline(selected.id);
	onSuccess(selected.label || basename(selected.originalPath));
}

function readStored<T>(key: string, parse: (value: string | null) => T): T {
	try {
		return parse(localStorage.getItem(key));
	} catch {
		return parse(null);
	}
}

function store(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// A preference only.
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function matches(query: string, ...texts: Array<string | undefined>): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	return texts.some((text) => text?.toLowerCase().includes(needle));
}

/** Lets a library card be dragged onto Media's timeline. */
function materialDrag(payload: MaterialPayload) {
	return {
		draggable: true,
		onDragStart: (event: ReactDragEvent<HTMLElement>) => {
			event.dataTransfer.setData(MEDIA_MATERIAL_MIME, JSON.stringify(payload));
			event.dataTransfer.effectAllowed = "copy";
		},
	};
}

/** A source's length: the project's own record, else what FFmpeg read for V.Clip. */
function useSourceDurations(): (item: Pick<AxcutMediaBoardItem, "assetId">) => number | undefined {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const probes = useVClipStore((state) => state.probes);
	return useMemo(() => {
		const assets = new Map((document?.assets ?? []).map((asset) => [asset.id, asset]));
		return (item) => {
			if (!item.assetId) return undefined;
			return (
				assets.get(item.assetId)?.durationSec ||
				probes[vclipKey(projectId, item.assetId)]?.durationSec ||
				undefined
			);
		};
	}, [document?.assets, probes, projectId]);
}

/**
 * Media: the material — V.Clip's clips, photos and whole videos — on the left; the composition
 * playing in the project's frame on the right; and, docked below, the timeline where the
 * pictures are laid under the soundtrack the Audio tab applied, each with its own length and
 * Remotion effect. Applying renders it onto Edit's timeline in one go.
 */
export function MediaStage({
	onAddToTimeline,
	onOpenInVClip,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
	/** Clips are cut in V.Clip; this opens it, on a source when one is given. */
	onOpenInVClip: (assetId: string | null) => void;
}) {
	const t = useScopedT("editor");
	const projectId = useProjectStore((state) => state.projectId);
	const document = useProjectStore((state) => state.document);
	const applying = useComposeStore((state) => state.applying);
	const board = boardOf(document);
	const videos = useMemo(() => (document?.assets ?? []).filter(isSourceVideo), [document?.assets]);
	const clips = useMemo(
		() => sortedBoardClips(board, document?.assets ?? []),
		[board, document?.assets],
	);
	const [tab, setTab] = useState<LibraryTab>(() =>
		board.clips.length > 0 ? "clips" : board.images.length > 0 ? "photos" : "videos",
	);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [detailId, setDetailId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [photoSec, setPhotoSec] = useState(() =>
		readStored(PHOTO_SEC_KEY, (value) => Number(value) || DEFAULT_IMAGE_SEC),
	);
	const [defaultEffect, setDefaultEffect] = useState<ClipEffectSelection>(() =>
		readStored(EFFECT_KEY, (value) =>
			value === "random" || isClipEffectId(value) ? value : "none",
		),
	);
	const [snapToNarration, setSnapToNarration] = useState(() =>
		readStored(SNAP_KEY, (value) => value !== "false"),
	);
	const sourceDuration = useSourceDurations();
	const detail = videos.find((asset) => asset.id === detailId) ?? null;
	const validPhotoSec =
		Number.isFinite(photoSec) && photoSec >= MIN_ITEM_SEC && photoSec <= MAX_IMAGE_SEC;
	const choice = () => ({ effect: defaultEffect });
	const items = board.items;
	const locked = Boolean(applying);

	const audioSec = document ? audioFitSummary(document).audioMs / 1000 : 0;
	const audioClips = useMemo(() => mediaAudioClips(document), [document]);
	const speech = useMemo(
		() => (document ? narrationSpeech(document).flatMap((entry) => entry.spoken) : []),
		[document],
	);
	const pauses = useMemo(() => (document ? narrationPauses(document) : []), [document]);
	const status = mixStatus(document);
	const audioState: AudioState =
		status === "applied" || status === "changed"
			? status
			: audioClips.length > 0
				? "applied"
				: "empty";

	// Whole videos and clips need their source length to be stretched; ask FFmpeg for the ones
	// the project does not know yet.
	useEffect(() => {
		for (const asset of document?.assets ?? []) {
			if (asset.durationSec || !items.some((item) => item.assetId === asset.id)) continue;
			void useVClipStore.getState().probe(asset);
		}
	}, [document?.assets, items]);

	/** Puts items in at `index` (the end when absent), selects the first and shows it. */
	const addItems = (added: AxcutMediaBoardItem[], what: string, index?: number) => {
		if (added.length === 0) return;
		void mutateDocument((current) => addBoardItems(current, added, index), { history: true })
			.then((saved) => {
				if (!saved) return;
				setSelectedId(added[0].id);
				const next = boardOf(useProjectStore.getState().document).items;
				const at = next.findIndex((item) => item.id === added[0].id);
				if (at >= 0) useMediaPreview.getState().seekTo(itemStarts(next)[at] + 0.001);
				toast.success(`${what}을(를) 타임라인에 추가했습니다.`);
			})
			.catch((error: unknown) =>
				toast.error("타임라인에 추가하지 못했습니다.", { description: message(error) }),
			);
	};

	const itemOfVideo = async (asset: AxcutAsset) => {
		const durationSec =
			asset.durationSec || (await useVClipStore.getState().probe(asset)).durationSec;
		if (!durationSec) {
			toast.error("영상 길이를 읽지 못해 추가하지 못했습니다.");
			return null;
		}
		return videoItem(asset, durationSec, choice());
	};

	/** The item a library card makes, whether clicked or dropped. */
	const itemOf = async (payload: MaterialPayload) => {
		if (payload.kind === "clip") {
			const clip = board.clips.find((entry) => entry.id === payload.id);
			return clip ? clipItem(clip, choice()) : null;
		}
		if (payload.kind === "photo") {
			const image = board.images.find((entry) => entry.id === payload.id);
			if (!image) return null;
			if (!validPhotoSec) {
				toast.error(`사진 길이는 ${MIN_ITEM_SEC}–${MAX_IMAGE_SEC}초로 정해 주세요.`);
				return null;
			}
			return imageItem(image, photoSec, choice());
		}
		const asset = videos.find((entry) => entry.id === payload.id);
		return asset ? itemOfVideo(asset) : null;
	};

	const importVideos = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		if (busy) return;
		setBusy(true);
		try {
			const picker = await window.electronAPI?.openVideoFilesPicker?.();
			if (!picker)
				throw new Error("영상 가져오기는 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
			if (picker.canceled) return;
			if (!picker.success) throw new Error(picker.message || "영상을 읽을 수 없습니다.");
			let added = 0;
			for (const file of picker.files) {
				if (useProjectStore.getState().projectId !== projectId) return;
				const exists = useProjectStore
					.getState()
					.document?.assets.some((asset) => asset.originalPath === file.path);
				if (!exists && (await useProjectStore.getState().addAsset(file.path, file.name))) added++;
			}
			setTab("videos");
			if (added > 0) toast.success(`영상 ${added}개를 가져왔습니다.`);
			if (picker.rejected.length > 0)
				toast.error(`읽을 수 없는 파일 ${picker.rejected.length}개는 건너뛰었습니다.`, {
					description: picker.rejected.join(", "),
				});
		} catch (error) {
			toast.error(t("mediaStage.couldNotAddAsset"), { description: message(error) });
		} finally {
			setBusy(false);
		}
	};

	const importPhotos = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		if (busy) return;
		setBusy(true);
		try {
			const picker = await window.electronAPI?.openImageFilesPicker?.();
			if (!picker) throw new Error("사진 추가는 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
			if (picker.canceled) return;
			if (!picker.success) throw new Error(picker.message || "사진을 읽을 수 없습니다.");
			const drafts: ImageDraft[] = [];
			for (const file of picker.files) {
				const size = await readImageSize(toFileUrl(file.path));
				drafts.push({ path: file.path, label: file.name, ...(size ?? {}) });
			}
			const saved = await mutateDocument((document) => addBoardImages(document, drafts).document, {
				history: true,
			});
			setTab("photos");
			if (saved) toast.success(`사진 ${drafts.length}장을 추가했습니다.`);
			if (picker.rejected.length > 0)
				toast.error(`읽을 수 없는 사진 ${picker.rejected.length}장은 건너뛰었습니다.`, {
					description: picker.rejected.join(", "),
				});
		} catch (error) {
			toast.error("사진을 추가하지 못했습니다.", { description: message(error) });
		} finally {
			setBusy(false);
		}
	};

	const fitToAudio = () => {
		if (!document || items.length === 0 || audioSec <= 0) return;
		const result = fitComposition(items, audioSec, sourceDuration, {
			pausesSec: snapToNarration ? pauses : [],
		});
		void edit((current) => setBoardItemRanges(current, result.ranges));
		if (result.shortSec > 0)
			toast.warning(`영상이 ${formatSeconds(result.shortSec)} 모자랍니다.`, {
				description: "모든 항목을 최대로 늘렸습니다. 클립이나 사진을 더 넣으세요.",
			});
		else if (result.overSec > 0)
			toast.warning(`항목이 많아 ${formatSeconds(result.overSec)} 넘칩니다.`, {
				description: `모든 항목을 ${MIN_ITEM_SEC}초로 줄였습니다. 몇 개를 빼세요.`,
			});
		else {
			const notes = [
				result.snapped ? "나레이션이 쉬는 곳으로 컷을 옮겼습니다." : "",
				result.reused
					? "쓰지 않은 원본이 모자라 일부 클립이 다른 클립과 같은 장면을 다시 씁니다. 클립이나 사진을 더 넣으면 겹치지 않습니다."
					: "",
			].filter(Boolean);
			const text = `조합을 Audio 길이 ${formatSeconds(audioSec)}에 맞췄습니다.`;
			if (result.reused) toast.warning(text, { description: notes.join(" ") });
			else toast.success(text, notes.length > 0 ? { description: notes.join(" ") } : undefined);
		}
	};

	// Media's own keys. The editor's are for Edit's timeline, and stand down here.
	const keys = useRef({ selectedId, items, locked });
	keys.current = { selectedId, items, locked };
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (isTextEditingTarget(event.target) || isModalOpen()) return;
			if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter"))
				return;
			const { selectedId: id, items: list, locked: frozen } = keys.current;
			const preview = useMediaPreview.getState();
			const ctrl = event.ctrlKey || event.metaKey;
			const index = list.findIndex((item) => item.id === id);
			if (event.key === " ") {
				event.preventDefault();
				preview.toggle();
			} else if (event.key === "Home") {
				event.preventDefault();
				preview.seekTo(0);
			} else if (
				event.altKey &&
				index >= 0 &&
				!frozen &&
				(event.key === "ArrowLeft" || event.key === "ArrowRight")
			) {
				event.preventDefault();
				const to = index + (event.key === "ArrowLeft" ? -1 : 1);
				if (to >= 0 && to < list.length && id)
					void edit((current) => moveBoardItem(current, id, to));
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				const step = (event.shiftKey ? 1 : 1 / 30) * (event.key === "ArrowLeft" ? -1 : 1);
				preview.seekTo(preview.timeSec + step);
			} else if (id && !frozen && (event.key === "Delete" || event.key === "Backspace")) {
				event.preventDefault();
				setSelectedId(null);
				void edit((current) => removeBoardItem(current, id));
			} else if (id && !frozen && ctrl && event.key.toLowerCase() === "d") {
				event.preventDefault();
				let copy: string | null = null;
				void edit((current) => {
					const result = duplicateBoardItem(current, id);
					copy = result.id;
					return result.document;
				}).then(() => {
					if (copy) setSelectedId(copy);
				});
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const shownClips = clips.filter((clip) =>
		matches(
			query,
			clip.label,
			clip.note,
			document?.assets.find((asset) => asset.id === clip.assetId)?.label,
		),
	);
	const shownPhotos = board.images.filter((image) => matches(query, image.label, image.path));
	const shownVideos = videos.filter((asset) => matches(query, asset.label, asset.originalPath));

	return (
		<div className={styles.root}>
			<div className={styles.stage}>
				<div className={styles.page}>
					<div className={styles.inner}>
						<header className={styles.header}>
							<div>
								<h1>Media</h1>
								<p className={styles.hint}>
									Audio에서 반영한 오디오가 아래 타임라인 맨 위에 놓입니다. 그 아래 줄에 V.Clip
									클립과 사진·영상을 놓고, 항목마다 길이와 Remotion 효과를 정해 오디오에 맞추세요.
									다 되면 <strong>Edit에 반영</strong>합니다.
								</p>
							</div>
						</header>
						<div className={styles.columns}>
							<section className={styles.library} aria-label="소재">
								<div className={styles.tabs} role="tablist" aria-label="소재 종류">
									<LibraryTabButton
										tab="clips"
										current={tab}
										onSelect={setTab}
										icon={<Scissors size={14} />}
										label={`V.Clip 클립 ${board.clips.length}`}
									/>
									<LibraryTabButton
										tab="photos"
										current={tab}
										onSelect={setTab}
										icon={<ImageIcon size={14} />}
										label={`사진 ${board.images.length}`}
									/>
									<LibraryTabButton
										tab="videos"
										current={tab}
										onSelect={setTab}
										icon={<Film size={14} />}
										label={`영상 ${videos.length}`}
									/>
								</div>
								<div className={styles.search}>
									<Search size={15} />
									<input
										value={query}
										onChange={(event) => setQuery(event.target.value)}
										placeholder={t("mediaStage.searchPlaceholder")}
									/>
								</div>

								{tab === "clips" ? (
									<>
										<div className={styles.row}>
											<button
												type="button"
												className={`${styles.button} ${styles.primary}`}
												disabled={shownClips.length === 0 || locked}
												onClick={() =>
													addItems(
														shownClips.map((clip) => clipItem(clip, choice())),
														`클립 ${shownClips.length}개`,
													)
												}
											>
												<ListPlus size={15} />
												모두 타임라인에 추가
											</button>
											<button
												type="button"
												className={styles.button}
												onClick={() => onOpenInVClip(null)}
											>
												<Scissors size={14} />
												V.Clip에서 나누기
											</button>
										</div>
										{clips.length === 0 ? (
											<p className={styles.emptyNote}>
												V.Clip에서 영상을 구간으로 나누면 여기에 모입니다. 나누기는 원본을 건드리지
												않습니다.
											</p>
										) : (
											<div className={styles.cards}>
												{shownClips.map((clip) => (
													<ClipCard
														key={clip.id}
														clip={clip}
														asset={document?.assets.find((asset) => asset.id === clip.assetId)}
														used={items.some((item) => item.clipId === clip.id)}
														disabled={locked}
														onAdd={() => addItems([clipItem(clip, choice())], "클립")}
													/>
												))}
											</div>
										)}
									</>
								) : tab === "photos" ? (
									<>
										<div className={styles.row}>
											<button
												type="button"
												className={`${styles.button} ${styles.primary}`}
												disabled={!projectId || busy}
												onClick={() => void importPhotos()}
											>
												<Plus size={15} />
												{busy ? "준비 중…" : "사진 추가"}
											</button>
											<label className={styles.inline}>
												사진 길이 (초)
												<input
													type="number"
													aria-label="사진 길이 (초)"
													min={MIN_ITEM_SEC}
													max={MAX_IMAGE_SEC}
													step={0.5}
													value={Number.isFinite(photoSec) ? photoSec : ""}
													onChange={(event) => {
														setPhotoSec(event.target.valueAsNumber);
														if (event.target.valueAsNumber >= MIN_ITEM_SEC)
															store(PHOTO_SEC_KEY, String(event.target.valueAsNumber));
													}}
												/>
											</label>
											<button
												type="button"
												className={styles.button}
												disabled={shownPhotos.length === 0 || !validPhotoSec || locked}
												onClick={() =>
													addItems(
														shownPhotos.map((image) => imageItem(image, photoSec, choice())),
														`사진 ${shownPhotos.length}장`,
													)
												}
											>
												<ListPlus size={15} />
												모두 타임라인에 추가
											</button>
										</div>
										{board.images.length === 0 ? (
											<p className={styles.emptyNote}>
												사진은 원본 파일 그대로 두고, 타임라인에서 정한 길이와 효과로 Edit에 반영할
												때 만들어집니다.
											</p>
										) : (
											<div className={styles.cards}>
												{shownPhotos.map((image) => (
													<PhotoCard
														key={image.id}
														image={image}
														used={items.some((item) => item.imageId === image.id)}
														disabled={!validPhotoSec || locked}
														onAdd={() => addItems([imageItem(image, photoSec, choice())], "사진")}
													/>
												))}
											</div>
										)}
									</>
								) : (
									<>
										<div className={styles.row}>
											<button
												type="button"
												className={`${styles.button} ${styles.primary}`}
												disabled={!projectId || busy}
												onClick={() => void importVideos()}
											>
												<Plus size={15} />
												{busy ? "준비 중…" : "영상 추가"}
											</button>
										</div>
										{videos.length === 0 ? (
											<p className={styles.emptyNote}>{t("mediaStage.emptyHint")}</p>
										) : (
											<div className={styles.cards}>
												{shownVideos.map((asset) => (
													<VideoCard
														key={asset.id}
														asset={asset}
														used={items.some(
															(item) => item.kind === "video" && item.assetId === asset.id,
														)}
														disabled={locked}
														onAdd={() =>
															void itemOfVideo(asset).then((item) => {
																if (item)
																	addItems([item], asset.label || basename(asset.originalPath));
															})
														}
														onSplit={() => onOpenInVClip(asset.id)}
														onTranscript={() => setDetailId(asset.id)}
														onAddToTimeline={() =>
															void addSelectedAssetToTimeline(asset, onAddToTimeline, (label) =>
																toast.success(t("mediaStage.addedToTimeline", { label })),
															).catch(() => undefined)
														}
													/>
												))}
											</div>
										)}
									</>
								)}
								<p className={styles.hint}>
									카드를 아래 타임라인의 원하는 자리로 끌어다 놓아도 됩니다.
								</p>
							</section>
							<MediaComposition
								selectedId={selectedId}
								onSelect={setSelectedId}
								defaultEffect={defaultEffect}
								onDefaultEffect={(effect) => {
									setDefaultEffect(effect);
									store(EFFECT_KEY, effect);
								}}
								sourceDuration={sourceDuration}
							/>
						</div>
					</div>
				</div>
				<div className={styles.dock}>
					<MediaTimeline
						items={items}
						images={board.images}
						assets={document?.assets ?? []}
						audio={audioClips}
						audioSec={audioSec}
						speech={speech}
						pauses={pauses}
						audioState={audioState}
						selectedId={selectedId}
						locked={locked}
						sourceDuration={sourceDuration}
						onSelect={setSelectedId}
						onResize={(id, range) => void edit((current) => updateBoardItem(current, id, range))}
						onMove={(id, toIndex) => void edit((current) => moveBoardItem(current, id, toIndex))}
						onDropMaterial={(payload, index) =>
							void itemOf(payload).then((item) => {
								if (item) addItems([item], item.label || "항목", index);
							})
						}
						fit={{
							onFit: fitToAudio,
							snap: snapToNarration,
							onSnap: (value) => {
								setSnapToNarration(value);
								store(SNAP_KEY, String(value));
							},
							pauseCount: pauses.length,
						}}
					/>
				</div>
			</div>
			{detail ? <MediaTranscriptPanel asset={detail} onClose={() => setDetailId(null)} /> : null}
		</div>
	);
}

function LibraryTabButton({
	tab,
	current,
	onSelect,
	icon,
	label,
}: {
	tab: LibraryTab;
	current: LibraryTab;
	onSelect: (tab: LibraryTab) => void;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button type="button" role="tab" aria-selected={tab === current} onClick={() => onSelect(tab)}>
			{icon}
			{label}
		</button>
	);
}

function ClipCard({
	clip,
	asset,
	used,
	disabled,
	onAdd,
}: {
	clip: AxcutMediaBoardClip;
	asset: AxcutAsset | undefined;
	used: boolean;
	disabled: boolean;
	onAdd: () => void;
}) {
	const length = clip.endSec - clip.startSec;
	const thumbnail = useThumbnail(asset?.originalPath ?? null, clip.startSec + length / 2);
	const range = `${formatSec(clip.startSec)}–${formatSec(clip.endSec)}`;
	return (
		<article
			className={styles.card}
			data-used={used}
			aria-label={`클립 ${clip.label}`}
			{...materialDrag({ kind: "clip", id: clip.id })}
		>
			<div className={styles.cardThumb}>
				{thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <Film size={24} />}
				{clip.score !== undefined ? <span className={styles.badge}>{clip.score}</span> : null}
				<span className={styles.lengthBadge}>{length.toFixed(1)}초</span>
			</div>
			<div className={styles.cardBody}>
				<strong title={clip.note || clip.label}>{clip.note || range}</strong>
				<span title={asset?.originalPath}>
					{asset?.label ?? "원본 없음"} · {range}
				</span>
				<div className={styles.cardActions}>
					<button
						type="button"
						className={styles.primary}
						disabled={!asset || disabled}
						onClick={onAdd}
					>
						<SquarePlus size={13} />
						{used ? "한 번 더 추가" : "타임라인에 추가"}
					</button>
					<button
						type="button"
						aria-label={`${range} 클립 삭제`}
						title="클립 목록에서 지웁니다. 타임라인에 놓은 항목은 남습니다."
						onClick={() =>
							void mutateDocument((document) => removeBoardClip(document, clip.id), {
								history: true,
							})
						}
					>
						<Trash2 size={13} />
					</button>
				</div>
			</div>
		</article>
	);
}

function PhotoCard({
	image,
	used,
	disabled,
	onAdd,
}: {
	image: AxcutMediaBoardImage;
	used: boolean;
	disabled: boolean;
	onAdd: () => void;
}) {
	return (
		<article
			className={styles.card}
			data-used={used}
			aria-label={`사진 ${image.label}`}
			{...materialDrag({ kind: "photo", id: image.id })}
		>
			<div className={styles.cardThumb}>
				<img src={toFileUrl(image.path)} alt="" draggable={false} />
			</div>
			<div className={styles.cardBody}>
				<strong title={image.path}>{image.label}</strong>
				<span>{image.width && image.height ? `${image.width}×${image.height}` : "사진"}</span>
				<div className={styles.cardActions}>
					<button type="button" className={styles.primary} disabled={disabled} onClick={onAdd}>
						<SquarePlus size={13} />
						{used ? "한 번 더 추가" : "타임라인에 추가"}
					</button>
					<button
						type="button"
						aria-label={`${image.label} 사진 삭제`}
						title="사진과, 타임라인에서 이 사진을 쓰는 항목을 지웁니다."
						onClick={() =>
							void mutateDocument((document) => removeBoardImage(document, image.id), {
								history: true,
							})
						}
					>
						<Trash2 size={13} />
					</button>
				</div>
			</div>
		</article>
	);
}

function VideoCard({
	asset,
	used,
	disabled,
	onAdd,
	onSplit,
	onTranscript,
	onAddToTimeline,
}: {
	asset: AxcutAsset;
	used: boolean;
	disabled: boolean;
	onAdd: () => void;
	onSplit: () => void;
	onTranscript: () => void;
	onAddToTimeline: () => void;
}) {
	const transcriptions = useAssetTranscriptions();
	const thumbnail = useThumbnail(asset.originalPath, Math.min(1, (asset.durationSec ?? 2) / 2));
	const name = asset.label || basename(asset.originalPath);
	const transcription = transcriptions[asset.id] ?? {
		assetId: asset.id,
		status: "idle" as AssetTranscriptionStatus,
	};
	const drag = materialDrag({ kind: "video", id: asset.id });
	return (
		<article
			className={styles.card}
			data-used={used}
			aria-label={`영상 ${name}`}
			draggable
			onDragStart={(event) => {
				drag.onDragStart(event);
				event.dataTransfer.setData(ASSET_MIME, asset.id);
			}}
		>
			<div className={styles.cardThumb}>
				{thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <Film size={24} />}
				<span className={styles.lengthBadge}>{formatSeconds(asset.durationSec ?? 0)}</span>
			</div>
			<div className={styles.cardBody}>
				<strong title={asset.originalPath}>{name}</strong>
				<span className={styles.meta}>
					{formatBytes(asset.sizeBytes)}
					<TranscriptionStatusDot view={transcription} />
				</span>
				<div className={styles.cardActions}>
					<button type="button" className={styles.primary} disabled={disabled} onClick={onAdd}>
						<SquarePlus size={13} />
						{used ? "한 번 더 추가" : "전체 추가"}
					</button>
					<button
						type="button"
						aria-label={`${name} V.Clip에서 나누기`}
						title="V.Clip에서 나누기"
						onClick={onSplit}
					>
						<Scissors size={13} />
					</button>
					<button
						type="button"
						aria-label={`${name} 대본`}
						title="대본 보기"
						onClick={onTranscript}
					>
						<FileText size={13} />
					</button>
					<button
						type="button"
						aria-label={`${name} Edit 타임라인에 바로 추가`}
						title="효과 없이 Edit 타임라인 끝에 바로 추가"
						onClick={onAddToTimeline}
					>
						<Plus size={13} />
					</button>
				</div>
			</div>
		</article>
	);
}
