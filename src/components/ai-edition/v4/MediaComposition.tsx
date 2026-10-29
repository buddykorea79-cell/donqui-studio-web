import {
	ArrowLeft,
	ArrowRight,
	Copy,
	Film,
	Image as ImageIcon,
	Pause,
	Play,
	Shuffle,
	SkipBack,
	Square,
	Trash2,
	WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type {
	AxcutAsset,
	AxcutDocument,
	AxcutMediaBoardImage,
	AxcutMediaBoardItem,
} from "@/lib/ai-edition/schema";
import { getOutputSettings, projectOutputFrame } from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import { mixStatus } from "@/lib/audio-board/board";
import {
	CLIP_EFFECT_FPS,
	CLIP_EFFECTS,
	type ClipEffectSelection,
} from "@/lib/clip-effects/catalog";
import type { SequencePart } from "@/lib/clip-effects/MediaSequenceComposition";
import { clipEffectLabel, itemNeedsRender } from "@/lib/media-board/apply";
import {
	boardOf,
	clearBoardItems,
	itemDurationSec,
	itemEffect,
	MAX_IMAGE_SEC,
	MIN_ITEM_SEC,
	moveBoardItem,
	removeBoardItem,
	reshuffleRandomItems,
	resolvedItemEffect,
	setAllItemsEffect,
	updateBoardItem,
} from "@/lib/media-board/board";
import { itemWithDuration } from "@/lib/media-board/fit";
import { mutateDocument } from "@/lib/media-board/mutate";
import { useMediaPreview } from "@/lib/media-board/preview";
import { useComposeStore } from "@/lib/media-board/store";
import { useThumbnail } from "@/lib/media-board/thumbnails";
import { compositionSec, duplicateBoardItem, mediaAudioClips } from "@/lib/media-board/timeline";
import { MediaPreview } from "./MediaPreview";
import styles from "./MediaStage.module.css";

export function EffectOptions() {
	return (
		<>
			<option value="none">효과 없음</option>
			<option value="random">랜덤 적용</option>
			{CLIP_EFFECTS.map((item) => (
				<option key={item.id} value={item.id}>
					{item.label}
				</option>
			))}
		</>
	);
}

export function edit(change: (document: AxcutDocument) => AxcutDocument) {
	return mutateDocument(change, { history: true }).catch((error: unknown) => {
		toast.error("조합을 저장하지 못했습니다.", {
			description: error instanceof Error ? error.message : String(error),
		});
		return false;
	});
}

/** The composition in frames, the way the preview plays it and applying will render it. */
function sequenceParts(
	items: AxcutMediaBoardItem[],
	images: AxcutMediaBoardImage[],
	assets: AxcutAsset[],
): SequencePart[] {
	let from = 0;
	return items.flatMap((item): SequencePart[] => {
		const frames = Math.max(1, Math.round(itemDurationSec(item) * CLIP_EFFECT_FPS));
		const start = from;
		from += frames;
		const effect = resolvedItemEffect(item);
		if (item.kind === "image") {
			const image = images.find((entry) => entry.id === item.imageId);
			return image
				? [
						{
							id: item.id,
							sourceUrl: toFileUrl(image.path),
							sourceKind: "image",
							startMs: 0,
							from: start,
							frames,
							effect,
						},
					]
				: [];
		}
		const asset = assets.find((entry) => entry.id === item.assetId);
		return asset
			? [
					{
						id: item.id,
						sourceUrl: toFileUrl(asset.originalPath),
						sourceKind: "video",
						startMs: Math.round(item.startSec * 1000),
						from: start,
						frames,
						effect,
					},
				]
			: [];
	});
}

/**
 * Media's composition as it plays — in the project's frame, over the soundtrack — with the
 * selected item's settings, the effects, and applying it all onto Edit's timeline. The items
 * themselves are laid out on the timeline docked below.
 */
export function MediaComposition({
	selectedId,
	onSelect,
	defaultEffect,
	onDefaultEffect,
	sourceDuration,
}: {
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	defaultEffect: ClipEffectSelection;
	onDefaultEffect: (effect: ClipEffectSelection) => void;
	sourceDuration: (item: Pick<AxcutMediaBoardItem, "assetId">) => number | undefined;
}) {
	const document = useProjectStore((state) => state.document);
	const applying = useComposeStore((state) => state.applying);
	const [confirmReplace, setConfirmReplace] = useState(false);
	const board = boardOf(document);
	const items = board.items;
	const assets = document?.assets ?? [];
	const totalSec = compositionSec(items);
	const toRender = items.filter(itemNeedsRender).length;
	const timelineClips = document?.timeline.clips.length ?? 0;
	const locked = Boolean(applying);
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const status = mixStatus(document);

	const frame = projectOutputFrame(document);
	const fit = getOutputSettings(document).mediaFit;
	const parts = useMemo(
		() => sequenceParts(items, board.images, assets),
		[items, board.images, assets],
	);
	const audioClips = useMemo(() => mediaAudioClips(document), [document]);
	const audio = useMemo(
		() =>
			audioClips.flatMap((clip) => {
				const asset = assets.find((entry) => entry.id === clip.assetId);
				return asset
					? [
							{
								id: clip.id,
								url: toFileUrl(asset.originalPath),
								from: Math.round(clip.startSec * CLIP_EFFECT_FPS),
								frames: Math.max(1, Math.round((clip.endSec - clip.startSec) * CLIP_EFFECT_FPS)),
								startFrom: Math.round(clip.offsetSec * CLIP_EFFECT_FPS),
							},
						]
					: [];
			}),
		[audioClips, assets],
	);
	const audioEnd = Math.max(0, ...audioClips.map((clip) => clip.endSec));
	const previewSec = Math.max(totalSec, audioEnd);

	const startApply = (mode: "replace" | "append") => {
		setConfirmReplace(false);
		useMediaPreview.getState().controls?.pause();
		void useComposeStore.getState().apply(mode);
	};

	return (
		<section className={styles.composition} aria-label="조합">
			<div className={styles.sectionHead}>
				<h2>조합</h2>
				<span className={styles.hint}>
					항목 {items.length}개 · {formatSec(totalSec)} · {frame.width}×{frame.height}
				</span>
				{items.length > 0 ? (
					<button
						type="button"
						className={styles.textButton}
						disabled={locked}
						onClick={() => {
							onSelect(null);
							void edit(clearBoardItems);
						}}
					>
						모두 비우기
					</button>
				) : null}
			</div>

			{items.length === 0 && audio.length === 0 ? (
				<div className={styles.empty}>
					<WandSparkles size={28} />
					<strong>왼쪽의 클립·사진·영상을 아래 타임라인에 놓으세요</strong>
					<p className={styles.hint}>
						Audio 탭에서 ‘Media에 반영’한 오디오가 타임라인 맨 위에 놓이고, 영상과 사진은 그 아래
						줄에 차례로 이어집니다. 항목마다 Remotion 효과와 길이를 정해 오디오에 맞추세요.
					</p>
				</div>
			) : (
				<>
					<MediaPreview
						parts={parts}
						audio={audio}
						durationSec={Math.max(previewSec, 1 / CLIP_EFFECT_FPS)}
						width={frame.width}
						height={frame.height}
						fit={fit}
					/>
					<Transport durationSec={previewSec} />
				</>
			)}

			{status === "changed" || status === "unapplied" ? (
				<p className={styles.fitPending} role="status">
					Audio 탭에서 바꾼 오디오가 아직 반영되지 않았습니다. Audio 탭에서 ‘Media에 반영’을
					누르세요.
				</p>
			) : null}

			{selected ? (
				<ItemInspector
					key={selected.id}
					item={selected}
					index={items.indexOf(selected)}
					count={items.length}
					asset={assets.find((asset) => asset.id === selected.assetId)}
					image={board.images.find((image) => image.id === selected.imageId)}
					sourceDurationSec={sourceDuration(selected)}
					locked={locked}
					onSelect={onSelect}
				/>
			) : items.length > 0 ? (
				<p className={styles.note}>
					타임라인에서 항목을 누르면 길이와 효과를 바꿀 수 있습니다. 오른쪽 끝을 끌면 길이가,
					가운데를 끌면 순서가 바뀝니다. <kbd>Space</kbd> 재생 · <kbd>Delete</kbd> 빼기 ·{" "}
					<kbd>Ctrl</kbd>+<kbd>D</kbd> 복제
				</p>
			) : null}

			<div className={styles.effectBar}>
				<label className={styles.inline}>
					새 항목 효과
					<select
						aria-label="새 항목 효과"
						value={defaultEffect}
						onChange={(event) => onDefaultEffect(event.target.value as ClipEffectSelection)}
					>
						<EffectOptions />
					</select>
				</label>
				<button
					type="button"
					className={styles.button}
					disabled={locked || items.length === 0}
					onClick={() => void edit((current) => setAllItemsEffect(current, defaultEffect))}
				>
					모든 항목에 적용
				</button>
				{items.some((item) => itemEffect(item) === "random") ? (
					<button
						type="button"
						className={styles.button}
						disabled={locked}
						onClick={() => void edit(reshuffleRandomItems)}
					>
						<Shuffle size={14} />
						랜덤 다시 섞기
					</button>
				) : null}
			</div>

			<div className={styles.applyBar}>
				<span className={styles.hint}>
					{toRender > 0
						? `효과·사진 ${toRender}개는 Edit에 반영할 때 ${frame.width}×${frame.height}로 렌더링합니다. 한 번 만든 결과는 다시 쓰입니다.`
						: "효과 없는 클립은 원본에서 바로 재생되어 렌더링이 필요 없습니다."}
				</span>
				{applying ? (
					<div className={styles.applying} role="status">
						<div
							className={styles.progress}
							role="progressbar"
							aria-label="조합 렌더링"
							aria-valuemin={0}
							aria-valuemax={applying.total || 1}
							aria-valuenow={applying.done}
						>
							<span
								style={{
									width: `${applying.total ? (applying.done / applying.total) * 100 : 0}%`,
								}}
							/>
						</div>
						<span>
							{applying.total > 0 && applying.done < applying.total
								? `렌더링 ${applying.done + 1} / ${applying.total} · ${applying.label}`
								: "Edit 타임라인에 놓는 중…"}
						</span>
						<button
							type="button"
							className={styles.button}
							onClick={() => useComposeStore.getState().cancel()}
						>
							<Square size={13} />
							멈추기
						</button>
					</div>
				) : confirmReplace ? (
					<div className={styles.confirm} role="alertdialog" aria-label="Edit 타임라인 바꾸기">
						<p>
							Edit 타임라인의 클립 {timelineClips}개를 이 조합으로 바꿉니다. 그 클립에 붙은 줌 같은
							편집은 함께 사라지고, 자막과 Audio는 같은 시간에 그대로 남습니다. 실행 취소로 되돌릴
							수 있습니다.
						</p>
						<div className={styles.row}>
							<button
								type="button"
								className={`${styles.button} ${styles.primary}`}
								onClick={() => startApply("replace")}
							>
								바꾸기
							</button>
							<button
								type="button"
								className={styles.button}
								onClick={() => setConfirmReplace(false)}
							>
								취소
							</button>
						</div>
					</div>
				) : (
					<div className={styles.row}>
						<button
							type="button"
							className={`${styles.button} ${styles.primary}`}
							disabled={items.length === 0}
							onClick={() => (timelineClips > 0 ? setConfirmReplace(true) : startApply("replace"))}
						>
							<WandSparkles size={15} />
							Edit에 반영
						</button>
						<button
							type="button"
							className={styles.button}
							disabled={items.length === 0 || timelineClips === 0}
							onClick={() => startApply("append")}
						>
							Edit 끝에 추가
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

/** Play, pause and the clock, under the preview; the timeline below scrubs. */
function Transport({ durationSec }: { durationSec: number }) {
	const playing = useMediaPreview((state) => state.playing);
	const time = useMediaPreview((state) => state.timeSec);
	return (
		<div className={styles.transport}>
			<button
				type="button"
				className={styles.iconButton}
				aria-label="처음으로"
				title="처음으로 (Home)"
				onClick={() => useMediaPreview.getState().seekTo(0)}
			>
				<SkipBack size={15} />
			</button>
			<button
				type="button"
				className={`${styles.button} ${styles.primary}`}
				aria-label={playing ? "일시 정지" : "재생"}
				title="재생 / 일시 정지 (Space)"
				onClick={() => useMediaPreview.getState().toggle()}
			>
				{playing ? <Pause size={15} /> : <Play size={15} />}
				{playing ? "일시 정지" : "재생"}
			</button>
			<span className={styles.clock}>
				{formatSeconds(Math.min(time, durationSec))} / {formatSeconds(durationSec)}
			</span>
		</div>
	);
}

function ItemInspector({
	item,
	index,
	count,
	asset,
	image,
	sourceDurationSec,
	locked,
	onSelect,
}: {
	item: AxcutMediaBoardItem;
	index: number;
	count: number;
	asset: AxcutAsset | undefined;
	image: AxcutMediaBoardImage | undefined;
	sourceDurationSec: number | undefined;
	locked: boolean;
	onSelect: (id: string | null) => void;
}) {
	const effect = itemEffect(item);
	const resolved = resolvedItemEffect(item);
	const durationSec = itemDurationSec(item);
	const missing = item.kind === "image" ? !image : !asset;
	const thumbnail = useThumbnail(
		item.kind === "image" ? null : (asset?.originalPath ?? null),
		item.startSec + durationSec / 2,
	);
	const maxSec = item.kind === "image" ? MAX_IMAGE_SEC : (sourceDurationSec ?? durationSec);
	const kind = item.kind === "image" ? "사진" : item.kind === "clip" ? "클립" : "영상";

	return (
		<section className={styles.inspector} aria-label="항목 설정">
			<div className={styles.itemMain}>
				<span className={styles.index}>{index + 1}</span>
				<div className={styles.itemThumb}>
					{item.kind === "image" && image ? (
						<img src={toFileUrl(image.path)} alt="" draggable={false} />
					) : thumbnail ? (
						<img src={thumbnail} alt="" draggable={false} />
					) : item.kind === "image" ? (
						<ImageIcon size={18} />
					) : (
						<Film size={18} />
					)}
				</div>
				<div className={styles.itemText}>
					<strong title={item.label}>{item.label}</strong>
					<span>
						{kind}
						{item.kind === "image"
							? ""
							: ` · 원본 ${formatSec(item.startSec)}–${formatSec(item.endSec)}`}
						{missing ? " · 파일이 프로젝트에 없습니다" : ""}
					</span>
				</div>
			</div>
			<div className={styles.inspectorFields}>
				<SecondsField
					label="길이 (초)"
					value={durationSec}
					min={MIN_ITEM_SEC}
					max={maxSec}
					disabled={locked}
					onCommit={(value) =>
						void edit((current) =>
							updateBoardItem(current, item.id, itemWithDuration(item, value, sourceDurationSec)),
						)
					}
				/>
				{item.kind === "image" ? null : (
					<SecondsField
						label="원본 시작 (초)"
						value={item.startSec}
						min={0}
						max={Math.max(0, (sourceDurationSec ?? item.endSec) - durationSec)}
						disabled={locked}
						onCommit={(value) =>
							void edit((current) =>
								updateBoardItem(current, item.id, {
									startSec: value,
									endSec: Math.round((value + durationSec) * 1000) / 1000,
								}),
							)
						}
					/>
				)}
				<label className={styles.inline}>
					효과
					<select
						aria-label="항목 효과"
						className={styles.effectSelect}
						value={effect}
						disabled={locked}
						title={effect === "random" ? `랜덤 → ${clipEffectLabel(resolved)}` : undefined}
						onChange={(event) => {
							// Read now: the write runs on the queue, after React has put the controlled
							// select back to the value it still renders.
							const next = event.target.value as ClipEffectSelection;
							void edit((current) => updateBoardItem(current, item.id, { effect: next }));
						}}
					>
						<EffectOptions />
					</select>
				</label>
			</div>
			{effect === "random" ? (
				<p className={styles.itemNote}>랜덤 → {clipEffectLabel(resolved)}</p>
			) : null}
			<div className={styles.itemActions}>
				<button
					type="button"
					aria-label="앞으로"
					title="한 칸 앞으로 (Alt + ←)"
					disabled={locked || index === 0}
					onClick={() => void edit((current) => moveBoardItem(current, item.id, index - 1))}
				>
					<ArrowLeft size={14} />
				</button>
				<button
					type="button"
					aria-label="뒤로"
					title="한 칸 뒤로 (Alt + →)"
					disabled={locked || index === count - 1}
					onClick={() => void edit((current) => moveBoardItem(current, item.id, index + 1))}
				>
					<ArrowRight size={14} />
				</button>
				<button
					type="button"
					aria-label="복제"
					title="바로 뒤에 복제 (Ctrl + D)"
					disabled={locked}
					onClick={() => {
						let copy: string | null = null;
						void edit((current) => {
							const result = duplicateBoardItem(current, item.id);
							copy = result.id;
							return result.document;
						}).then(() => copy && onSelect(copy));
					}}
				>
					<Copy size={14} />
				</button>
				<button
					type="button"
					aria-label="빼기"
					title="조합에서 빼기 (Delete)"
					disabled={locked}
					onClick={() => {
						onSelect(null);
						void edit((current) => removeBoardItem(current, item.id));
					}}
				>
					<Trash2 size={14} />
				</button>
			</div>
		</section>
	);
}

function SecondsField({
	label,
	value,
	min,
	max,
	disabled,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	disabled: boolean;
	onCommit: (value: number) => void;
}) {
	const rounded = Math.round(value * 100) / 100;
	const [draft, setDraft] = useState(String(rounded));
	useEffect(() => setDraft(String(rounded)), [rounded]);
	const commit = () => {
		const parsed = Number(draft);
		if (Number.isFinite(parsed) && parsed >= min && Math.abs(parsed - rounded) > 0.001)
			onCommit(Math.min(max, parsed));
		else setDraft(String(rounded));
	};
	return (
		<label className={styles.duration}>
			{label}
			<input
				type="number"
				aria-label={label}
				min={min}
				max={max}
				step={0.1}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
		</label>
	);
}
