import {
	ArrowRight,
	Film,
	Minus,
	Play,
	Plus,
	ScanSearch,
	Scissors,
	Settings2,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import { audioFitSummary } from "@/lib/clip-effects/audioFit";
import { boardOf, isSourceVideo } from "@/lib/media-board/board";
import { useThumbnail } from "@/lib/media-board/thumbnails";
import {
	VCLIP_SEGMENT_LIMITS,
	type VClipProbeResult,
	vclipCategoryLabel,
} from "@/lib/vclip/contract";
import { selectedDurationSec, type VClipSegment } from "@/lib/vclip/segments";
import {
	isProvisional,
	segmentIsSplit,
	useVClipStore,
	type VClipRun,
	vclipKey,
} from "@/lib/vclip/store";
import { useVisionModelStore, visionModelStatus } from "@/lib/vclip/visionModels";
import { SegmentPreview } from "./SegmentPreview";
import styles from "./VClipStage.module.css";

/** How far one press of − / + moves an edge, as in AutoVeo. */
const NUDGE_SEC = 0.5;

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function binDurationSec(document: AxcutDocument | null): number {
	return boardOf(document).clips.reduce((sum, clip) => sum + clip.endSec - clip.startSec, 0);
}

/**
 * V.Clip — the step between Audio and Media that splits long footage into clips, AutoVeo's
 * "영상 클립" page: every source video on one page, each with its segments — found by a local
 * Ollama vision model or by frame quality, or added by hand — to preview, adjust and select.
 * Splitting only records ranges in Media's bin; effects and rendering belong to Media.
 */
export function VClipStage({
	onContinue,
	onOpenAiSettings,
}: {
	onContinue: () => void;
	/** The Ollama model is chosen in the AI settings dialog. */
	onOpenAiSettings: () => void;
}) {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const runs = useVClipStore((state) => state.runs);
	const segmentSec = useVClipStore((state) => state.segmentSec);
	const splitting = useVClipStore((state) => state.splitting);
	const [importing, setImporting] = useState(false);
	const [previewKey, setPreviewKey] = useState<string | null>(null);
	const sources = useMemo(() => (document?.assets ?? []).filter(isSourceVideo), [document?.assets]);
	const sourceIds = useMemo(() => sources.map((source) => source.id), [sources]);
	const store = useVClipStore.getState();
	const sourceRuns = sources.map((source) => runs[vclipKey(projectId, source.id)]);
	const segments = sourceRuns.flatMap((run) => run?.segments ?? []);
	const pending = segments.filter(
		(segment) => segment.selected && !segmentIsSplit(segment, document),
	);
	const busy = sourceRuns.some((run) => run?.status === "analyzing" || run?.status === "queued");
	const bin = boardOf(document).clips;
	const binSec = binDurationSec(document);
	const audioSec = document ? audioFitSummary(document).audioMs / 1000 : 0;
	const remainingSec = Math.max(0, audioSec - binSec);
	const validSegmentSec =
		Number.isFinite(segmentSec) &&
		segmentSec >= VCLIP_SEGMENT_LIMITS.minSec &&
		segmentSec <= VCLIP_SEGMENT_LIMITS.maxSec;

	useEffect(() => {
		if (!useVisionModelStore.getState().models) void useVisionModelStore.getState().load();
	}, []);

	const importVideos = async () => {
		if (!projectId || importing) return;
		setImporting(true);
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
				if (exists) continue;
				if (await useProjectStore.getState().addAsset(file.path, file.name)) added++;
			}
			if (added > 0) toast.success(`영상 ${added}개를 가져왔습니다.`);
			if (picker.rejected.length > 0)
				toast.error(`읽을 수 없는 파일 ${picker.rejected.length}개는 건너뛰었습니다.`, {
					description: picker.rejected.join(", "),
				});
		} catch (error) {
			toast.error("영상을 가져오지 못했습니다.", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setImporting(false);
		}
	};

	const importButton = (
		<button
			type="button"
			className={styles.button}
			disabled={!projectId || importing}
			onClick={() => void importVideos()}
		>
			<Plus size={15} />
			{importing ? "영상 준비 중…" : "영상 가져오기"}
		</button>
	);

	const splitButton = (
		<button
			type="button"
			className={`${styles.button} ${styles.primary}`}
			disabled={pending.length === 0 || splitting}
			onClick={() => void store.split(sources)}
		>
			<Scissors size={15} />
			{splitting
				? "클립으로 나누는 중…"
				: `선택한 구간 ${pending.length}개 클립으로 나누기 · ${formatSec(selectedDurationSec(pending))}`}
		</button>
	);

	return (
		<div className={styles.stage}>
			<div className={styles.inner}>
				<header className={styles.header}>
					<div>
						<h1>V.Clip</h1>
						<p className={styles.hint}>
							여러 촬영 영상을 한 화면에서 구간으로 나눕니다. 구간마다 미리 보고 시작·끝을 다듬은 뒤
							클립으로 나누면, Media에서 사진과 함께 조합하고 Remotion 효과를 입힐 수 있습니다.
						</p>
					</div>
					<button
						type="button"
						className={`${styles.button} ${styles.primary}`}
						onClick={onContinue}
					>
						Media로 이동 <ArrowRight size={15} />
					</button>
				</header>
				{!document ? (
					<div className={styles.empty}>
						<Film size={32} />
						<p className={styles.hint}>프로젝트를 먼저 만들거나 열어 주세요.</p>
					</div>
				) : sources.length === 0 ? (
					<div className={styles.empty}>
						<Film size={32} />
						<strong>나눌 영상을 가져오세요</strong>
						<p className={styles.hint}>
							드론·카메라로 찍은 긴 영상을 여러 개 한꺼번에 가져올 수 있습니다.
						</p>
						{importButton}
					</div>
				) : (
					<>
						<section className={styles.toolbar} aria-label="V.Clip 설정">
							{importButton}
							<label className={styles.inline}>
								클립 길이 (초)
								<input
									type="number"
									aria-label="클립 길이 (초)"
									min={VCLIP_SEGMENT_LIMITS.minSec}
									max={VCLIP_SEGMENT_LIMITS.maxSec}
									step={0.5}
									value={Number.isFinite(segmentSec) ? segmentSec : ""}
									onChange={(event) => store.setSegmentSec(event.target.valueAsNumber)}
								/>
							</label>
							<button
								type="button"
								className={styles.button}
								disabled={!validSegmentSec || segments.length === 0 || busy}
								title="모든 구간을 시작 위치는 두고 이 길이로 맞춥니다"
								onClick={() => store.resizeAll(sourceIds, segmentSec)}
							>
								모든 구간에 적용
							</button>
							{busy ? (
								<button type="button" className={styles.button} onClick={() => store.cancelAll()}>
									<Square size={14} />
									분석 멈추기
								</button>
							) : (
								<button
									type="button"
									className={`${styles.button} ${styles.primary}`}
									disabled={!validSegmentSec}
									onClick={() => store.analyzeAll(sources)}
								>
									<ScanSearch size={15} />
									모든 영상 구간 찾기
								</button>
							)}
							<AnalysisModel onOpenAiSettings={onOpenAiSettings} />
						</section>
						{!validSegmentSec ? (
							<p className={styles.error}>
								클립 길이는 {VCLIP_SEGMENT_LIMITS.minSec}~{VCLIP_SEGMENT_LIMITS.maxSec}초 사이로
								입력하세요. 기본은 {VCLIP_SEGMENT_LIMITS.defaultSec}초입니다.
							</p>
						) : null}

						<section className={styles.summaryBar} aria-label="V.Clip 요약">
							<div className={styles.stats}>
								<Stat value={sources.length} label="영상" />
								<Stat value={segments.length} label="구간" />
								<Stat
									value={pending.length}
									label="선택"
									detail={formatSec(selectedDurationSec(pending))}
								/>
								<Stat value={bin.length} label="나눈 클립" detail={formatSec(binSec)} />
							</div>
							{audioSec > 0 ? (
								<p className={styles.fit}>
									Audio {formatSeconds(audioSec)} · 나눈 클립 {formatSeconds(binSec)} ·{" "}
									<strong>남은 {formatSeconds(remainingSec)}</strong>
								</p>
							) : null}
							<div className={styles.row}>
								{remainingSec > 0 ? (
									<button
										type="button"
										className={styles.button}
										disabled={busy || segments.length === 0}
										onClick={() => store.selectToFill(sourceIds, remainingSec)}
									>
										남은 Audio만큼 선택
									</button>
								) : null}
								<button
									type="button"
									className={styles.button}
									disabled={busy || segments.length === 0}
									onClick={() => store.selectAll(sourceIds, true)}
								>
									모두 선택
								</button>
								<button
									type="button"
									className={styles.button}
									disabled={busy || segments.length === 0}
									onClick={() => store.selectAll(sourceIds, false)}
								>
									선택 해제
								</button>
								{splitButton}
							</div>
						</section>

						{sources.map((source) => (
							<SourcePanel
								key={vclipKey(projectId, source.id)}
								source={source}
								previewKey={previewKey}
								onPreview={setPreviewKey}
							/>
						))}

						<footer className={styles.footer}>
							{splitButton}
							<button type="button" className={styles.button} onClick={onContinue}>
								Media에서 조합하기 <ArrowRight size={15} />
							</button>
							<p className={styles.hint}>
								나누기는 원본을 건드리지 않고 구간만 기록하므로 바로 끝납니다. 나눈 클립은 Media의
								클립 목록에 모이고, 효과는 Media에서 조합할 때 고릅니다.
							</p>
						</footer>
					</>
				)}
			</div>
		</div>
	);
}

function Stat({ value, label, detail }: { value: number; label: string; detail?: string }) {
	return (
		<div className={styles.stat}>
			<strong>{value}</strong>
			<span>
				{label}
				{detail ? ` · ${detail}` : ""}
			</span>
		</div>
	);
}

function AnalysisModel({ onOpenAiSettings }: { onOpenAiSettings: () => void }) {
	const models = useVisionModelStore((state) => state.models);
	const loading = useVisionModelStore((state) => state.loading);
	const chosen = useVisionModelStore((state) => state.chosen);
	const status = visionModelStatus(models, loading, chosen);
	const text =
		status.kind === "checking"
			? "Ollama 확인 중…"
			: status.kind === "unavailable"
				? "Ollama 연결 안 됨 · 화질 점수로만 고릅니다"
				: status.kind === "no-models"
					? "Ollama 비전 모델 없음 · 화질 점수로만 고릅니다"
					: status.kind === "off"
						? "AI 없이 화질 점수로만 고릅니다"
						: `분석 모델 ${status.model}`;
	return (
		<span className={styles.model}>
			<span
				className={styles.modelDot}
				data-state={status.kind === "ready" ? "ready" : status.kind === "checking" ? "busy" : "off"}
			/>
			<span title={status.kind === "unavailable" ? (status.error ?? undefined) : undefined}>
				{text}
			</span>
			<button type="button" className={styles.linkButton} onClick={onOpenAiSettings}>
				<Settings2 size={13} />
				AI 설정
			</button>
		</span>
	);
}

function describeProbe(probe: VClipProbeResult | undefined): string {
	if (!probe) return "영상 정보 읽는 중…";
	if (!probe.success) return probe.error || "영상 정보를 읽지 못했습니다.";
	return [
		formatSeconds(probe.durationSec ?? 0),
		`${probe.width}×${probe.height}`,
		probe.fps ? `${Math.round(probe.fps * 100) / 100} fps` : null,
		probe.hasAudio ? null : "소리 없음",
	]
		.filter(Boolean)
		.join(" · ");
}

function runStatus(run: VClipRun | undefined): string | null {
	if (!run) return null;
	switch (run.status) {
		case "queued":
			return "분석 대기 중";
		case "analyzing":
			return run.total ? `구간 분석 ${run.completed} / ${run.total}` : "영상 정보 읽는 중…";
		case "canceled":
			return "분석을 멈췄습니다. 그때까지 찾은 구간만 보여 줍니다.";
		case "failed":
			return null;
		default:
			return null;
	}
}

function SourcePanel({
	source,
	previewKey,
	onPreview,
}: {
	source: AxcutAsset;
	previewKey: string | null;
	onPreview: (key: string | null) => void;
}) {
	const projectId = useProjectStore((state) => state.projectId);
	const document = useProjectStore((state) => state.document);
	const key = vclipKey(projectId, source.id);
	const probe = useVClipStore((state) => state.probes[key]);
	const run = useVClipStore((state) => state.runs[key]);
	const focused = useVClipStore((state) => state.focusId === source.id);
	const panelRef = useRef<HTMLElement>(null);
	const store = useVClipStore.getState();
	const { id, label, originalPath } = source;
	const segments = run?.segments ?? [];
	const analyzing = run?.status === "analyzing";
	const waiting = run?.status === "queued";
	const durationSec = probe?.success ? probe.durationSec : undefined;
	const aiFailures = segments.filter((segment) => segment.analysis?.aiError);
	const status = runStatus(run);
	const name = label || basename(originalPath);

	useEffect(() => {
		void useVClipStore.getState().probe({ id, label, originalPath });
	}, [id, label, originalPath]);

	useEffect(() => {
		if (!focused) return;
		panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
		useVClipStore.getState().focusSource(null);
	}, [focused]);

	return (
		<section ref={panelRef} className={styles.source} aria-label={`${name} 구간`}>
			<header className={styles.sourceHead}>
				<Film size={18} />
				<div className={styles.sourceTitle}>
					<h2 title={originalPath}>{name}</h2>
					<p className={probe && !probe.success ? styles.error : styles.hint}>
						{describeProbe(probe)}
						{segments.length > 0 ? ` · 구간 ${segments.length}개` : ""}
					</p>
				</div>
				<div className={styles.row}>
					{analyzing || waiting ? (
						<button type="button" className={styles.button} onClick={() => store.cancel(id)}>
							<X size={14} />
							{waiting ? "대기 취소" : "분석 멈추기"}
						</button>
					) : (
						<button
							type="button"
							className={styles.button}
							disabled={probe?.success === false}
							onClick={() => store.analyze({ id, label: name, originalPath })}
						>
							<ScanSearch size={14} />
							{run && run.status !== "idle" ? "구간 다시 찾기" : "구간 찾기"}
						</button>
					)}
					<button
						type="button"
						className={styles.button}
						disabled={!durationSec}
						onClick={() => store.addManualSegment({ id, label: name, originalPath })}
					>
						<Plus size={14} />
						구간 직접 추가
					</button>
				</div>
			</header>
			{analyzing && run ? (
				<div
					className={styles.progress}
					role="progressbar"
					aria-label={`${name} 구간 분석`}
					aria-valuemin={0}
					aria-valuemax={run.total || 1}
					aria-valuenow={run.completed}
				>
					<span style={{ width: `${run.total ? (run.completed / run.total) * 100 : 0}%` }} />
				</div>
			) : null}
			{status ? <p className={styles.hint}>{status}</p> : null}
			{run?.status === "failed" ? (
				<p role="alert" className={styles.error}>
					구간을 찾지 못했습니다: {run.error}
				</p>
			) : null}
			{run && run.unreadable > 0 && run.status !== "failed" ? (
				<p className={styles.hint}>{run.unreadable}개 구간은 영상을 읽지 못해 건너뛰었습니다.</p>
			) : null}
			{aiFailures.length > 0 ? (
				<p className={styles.warn} title={aiFailures[0].analysis?.aiError ?? undefined}>
					AI가 {aiFailures.length}개 구간을 판단하지 못해 화질 점수로 대신했습니다.
				</p>
			) : null}
			{segments.length === 0 && !analyzing ? (
				<p className={styles.hint}>
					‘구간 찾기’는 영상 전체에 고르게 퍼진 구간을 최대 {VCLIP_SEGMENT_LIMITS.maxCandidates}개
					뽑아 점수를 매기고, 가장 좋은 {VCLIP_SEGMENT_LIMITS.preselect}개를 먼저 선택합니다. 원하는
					자리가 있으면 ‘구간 직접 추가’로 넣고 다듬으세요.
				</p>
			) : null}
			{segments.length > 0 && durationSec ? (
				<SegmentTrack segments={segments} durationSec={durationSec} document={document} />
			) : null}
			{segments.length > 0 ? (
				<div className={styles.grid}>
					{segments.map((segment) => {
						const cardKey = `${key}\n${segment.id}`;
						return (
							<SegmentCard
								key={segment.id}
								source={source}
								segment={segment}
								durationSec={durationSec}
								split={segmentIsSplit(segment, document)}
								provisional={run ? isProvisional(segment, run) : false}
								previewing={previewKey === cardKey}
								onPreview={() => onPreview(previewKey === cardKey ? null : cardKey)}
							/>
						);
					})}
				</div>
			) : null}
		</section>
	);
}

function SegmentTrack({
	segments,
	durationSec,
	document,
}: {
	segments: VClipSegment[];
	durationSec: number;
	document: AxcutDocument | null;
}) {
	return (
		<div className={styles.track} aria-hidden>
			{segments.map((segment) => (
				<span
					key={segment.id}
					data-state={
						segmentIsSplit(segment, document) ? "split" : segment.selected ? "selected" : "idle"
					}
					style={{
						left: `${(segment.startSec / durationSec) * 100}%`,
						width: `${((segment.endSec - segment.startSec) / durationSec) * 100}%`,
					}}
				/>
			))}
		</div>
	);
}

function SegmentCard({
	source,
	segment,
	durationSec,
	split,
	provisional,
	previewing,
	onPreview,
}: {
	source: AxcutAsset;
	segment: VClipSegment;
	durationSec: number | undefined;
	/** In the bin with this exact range. */
	split: boolean;
	/** Still being analysed: re-ranked when the run ends, so it cannot be edited yet. */
	provisional: boolean;
	previewing: boolean;
	onPreview: () => void;
}) {
	const store = useVClipStore.getState();
	const { analysis } = segment;
	const length = segment.endSec - segment.startSec;
	const range = `${formatSec(segment.startSec)}–${formatSec(segment.endSec)}`;
	const thumbnail = useThumbnail(
		analysis?.thumbnail ? null : source.originalPath,
		segment.startSec + length / 2,
	);
	const changed = Boolean(segment.clipId) && !split;
	const adjust = (next: { startSec: number; endSec: number }, moved: "start" | "end" | "both") =>
		store.adjustSegment(source.id, segment.id, next, moved);

	return (
		<article
			className={styles.card}
			data-selected={segment.selected}
			data-split={split}
			aria-label={`구간 ${range}`}
		>
			<div className={styles.thumb} data-previewing={previewing}>
				{previewing ? (
					<SegmentPreview
						sourceUrl={toFileUrl(source.originalPath)}
						startSec={segment.startSec}
						endSec={segment.endSec}
						onSetStart={(sec) => adjust({ startSec: sec, endSec: segment.endSec }, "start")}
						onSetEnd={(sec) => adjust({ startSec: segment.startSec, endSec: sec }, "end")}
					/>
				) : (
					<button
						type="button"
						className={styles.poster}
						aria-label={`${range} 구간 미리보기`}
						onClick={onPreview}
					>
						{analysis?.thumbnail || thumbnail ? (
							<img src={analysis?.thumbnail ?? thumbnail ?? undefined} alt="" draggable={false} />
						) : (
							<Film size={28} />
						)}
						<span className={styles.playBadge}>
							<Play size={13} /> 미리보기
						</span>
					</button>
				)}
				{!previewing && analysis ? (
					<span className={styles.score} title={analysis.ai ? "AI 점수" : "화질 점수"}>
						{analysis.score}
					</span>
				) : null}
				{!previewing ? (
					<span className={styles.time}>
						{range} · {length.toFixed(1)}초
					</span>
				) : null}
			</div>
			<div className={styles.cardBody}>
				<div className={styles.chips}>
					{analysis ? (
						<span className={styles.chip}>
							{analysis.ai ? vclipCategoryLabel(analysis.ai.category) : "화질 점수"}
						</span>
					) : null}
					{analysis?.ai ? (
						<span className={`${styles.chip} ${styles.quiet}`} title="선명도·밝기·흔들림 점수">
							화질 {analysis.qualityScore}
						</span>
					) : null}
					{segment.origin === "manual" ? (
						<span className={`${styles.chip} ${styles.quiet}`}>직접 추가</span>
					) : null}
					{split ? <span className={`${styles.chip} ${styles.done}`}>클립 나눔</span> : null}
					{changed ? (
						<span className={`${styles.chip} ${styles.changed}`}>바뀜 · 다시 나누기</span>
					) : null}
				</div>
				{analysis ? <p className={styles.reason}>{analysis.reason}</p> : null}
				{analysis?.ai?.caption ? <p className={styles.caption}>“{analysis.ai.caption}”</p> : null}
				<RangeEditor
					segment={segment}
					durationSec={durationSec}
					disabled={provisional}
					onChange={adjust}
				/>
				<div className={styles.cardActions}>
					<button type="button" aria-pressed={previewing} onClick={onPreview}>
						{previewing ? "미리보기 닫기" : "미리보기"}
					</button>
					{split ? null : (
						<button
							type="button"
							className={segment.selected ? undefined : styles.primary}
							aria-pressed={segment.selected}
							disabled={provisional}
							onClick={() => store.toggleSegment(source.id, segment.id)}
						>
							{segment.selected ? "빼기" : "넣기"}
						</button>
					)}
					<button
						type="button"
						className={styles.iconAction}
						aria-label={`${range} 구간 삭제`}
						title={split || changed ? "구간과 나눈 클립을 지웁니다" : "구간을 지웁니다"}
						disabled={provisional}
						onClick={() => void store.removeSegment(source.id, segment.id)}
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>
		</article>
	);
}

/** Start, end and length, each with the AutoVeo nudges; typing commits on blur or Enter. */
function RangeEditor({
	segment,
	durationSec,
	disabled,
	onChange,
}: {
	segment: VClipSegment;
	durationSec: number | undefined;
	disabled: boolean;
	onChange: (range: { startSec: number; endSec: number }, moved: "start" | "end" | "both") => void;
}) {
	const { startSec, endSec } = segment;
	const length = endSec - startSec;
	return (
		<div className={styles.range}>
			<RangeField
				label="시작"
				value={startSec}
				max={durationSec}
				disabled={disabled}
				onCommit={(value) => onChange({ startSec: value, endSec }, "start")}
			/>
			<RangeField
				label="끝"
				value={endSec}
				max={durationSec}
				disabled={disabled}
				onCommit={(value) => onChange({ startSec, endSec: value }, "end")}
			/>
			<RangeField
				label="길이"
				value={length}
				max={durationSec}
				disabled={disabled}
				onCommit={(value) => onChange({ startSec, endSec: startSec + value }, "end")}
			/>
		</div>
	);
}

function RangeField({
	label,
	value,
	max,
	disabled,
	onCommit,
}: {
	label: string;
	value: number;
	max: number | undefined;
	disabled: boolean;
	onCommit: (value: number) => void;
}) {
	const rounded = Math.round(value * 100) / 100;
	const [draft, setDraft] = useState(String(rounded));
	useEffect(() => setDraft(String(rounded)), [rounded]);
	const commit = () => {
		const parsed = Number(draft);
		if (Number.isFinite(parsed) && Math.abs(parsed - rounded) > 0.001) onCommit(parsed);
		else setDraft(String(rounded));
	};
	return (
		<div className={styles.rangeField}>
			<span>{label}</span>
			<button
				type="button"
				aria-label={`${label} −${NUDGE_SEC}초`}
				disabled={disabled}
				onClick={() => onCommit(value - NUDGE_SEC)}
			>
				<Minus size={12} />
			</button>
			<input
				type="number"
				aria-label={`${label} (초)`}
				min={0}
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
			<button
				type="button"
				aria-label={`${label} +${NUDGE_SEC}초`}
				disabled={disabled}
				onClick={() => onCommit(value + NUDGE_SEC)}
			>
				<Plus size={12} />
			</button>
		</div>
	);
}
