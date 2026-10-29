import { Captions, FileUp, Heading1, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	addSubtitles,
	getSubtitleStyles,
	parseSubtitleText,
	patchSubtitleStyle,
	restyleSubtitles,
	SUBTITLE_EFFECTS,
	SUBTITLE_FONTS,
	SUBTITLE_KIND_LABELS,
	type SubtitleBox,
	type SubtitleEntry,
	type SubtitleKind,
	type SubtitlePosition,
	type SubtitleStyle,
	subtitleEntries,
	timeLines,
} from "@/lib/ai-edition/document/subtitles";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { projectOutputFrame } from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec, formatSeconds } from "@/lib/ai-edition/timeline/format";
import { mutateDocument } from "@/lib/media-board/mutate";
import styles from "./SubtitleTools.module.css";

/** A subtitle being typed in the quick bar: a new one from `startSec`, or `editId` retyped. */
export interface SubtitleDraft {
	kind: SubtitleKind;
	startSec: number;
	text: string;
	editId?: string;
}

export interface SubtitleActions {
	/** Opens the quick bar for a new subtitle of `kind` at the playhead. */
	add: (kind: SubtitleKind) => void;
	/** Opens the quick bar on an existing one. */
	edit: (id: string) => void;
	/** Moves the playhead to it and selects it on the timeline. */
	reveal: (entry: SubtitleEntry) => void;
	remove: (entry: SubtitleEntry) => void;
}

const SWATCHES = ["#ffffff", "#ffe14d", "#ffb020", "#ff5a5f", "#4dd0e1", "#7ee787", "#000000"];
const BOXES: Array<{ value: SubtitleBox; label: string }> = [
	{ value: "none", label: "없음" },
	{ value: "soft", label: "반투명" },
	{ value: "solid", label: "진하게" },
];
const POSITIONS: Array<{ value: SubtitlePosition; label: string }> = [
	{ value: "bottom", label: "아래" },
	{ value: "middle", label: "가운데" },
	{ value: "top", label: "위" },
];

function aspectOf(document: AxcutDocument | null): number {
	const frame = projectOutputFrame(document);
	return frame.width / frame.height;
}

function save(change: (document: AxcutDocument) => AxcutDocument) {
	return mutateDocument(change, { history: true }).catch((error: unknown) => {
		toast.error("자막을 저장하지 못했습니다.", {
			description: error instanceof Error ? error.message : String(error),
		});
		return false;
	});
}

/**
 * The Subtitles panel: buttons (and N / Shift+N) that open the quick bar at the playhead, the
 * look of each kind — changing it restyles every subtitle of that kind — the subtitles in time
 * order, and pasting or opening SRT, VTT or plain text.
 */
export function SubtitlePane({ actions }: { actions: SubtitleActions }) {
	const document = useProjectStore((state) => state.document);
	const [kind, setKind] = useState<SubtitleKind>("caption");
	const style = getSubtitleStyles(document)[kind];
	const entries = useMemo(() => subtitleEntries(document), [document]);
	const hasClips = Boolean(document?.timeline.clips.length);

	/** One write: the kind's look, and every subtitle of that kind wearing it. */
	const setStyle = (patch: Partial<SubtitleStyle>) =>
		void save((current) =>
			restyleSubtitles(patchSubtitleStyle(current, kind, patch), kind, aspectOf(current)),
		);

	return (
		<div className={styles.pane}>
			<header className={styles.head}>
				<h2>자막</h2>
				<p>
					재생 위치에 타이틀이나 일반 자막을 넣습니다. 넣은 자막은 타임라인의 주석 줄에 놓이고,
					누르면 위치·글꼴을 따로 바꿀 수 있습니다.
				</p>
			</header>

			<div className={styles.addRow}>
				<button
					type="button"
					className={styles.primary}
					disabled={!hasClips}
					onClick={() => actions.add("caption")}
				>
					<Captions size={15} />
					일반 자막 <kbd>N</kbd>
				</button>
				<button
					type="button"
					className={styles.primary}
					disabled={!hasClips}
					onClick={() => actions.add("title")}
				>
					<Heading1 size={15} />
					타이틀 <kbd>Shift+N</kbd>
				</button>
			</div>
			{!hasClips ? (
				<p className={styles.note}>자막을 넣을 영상을 먼저 타임라인에 놓으세요.</p>
			) : null}

			<section className={styles.section} aria-label="자막 모양">
				<div className={styles.kinds} role="tablist" aria-label="자막 종류">
					{(["caption", "title"] as const).map((value) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={kind === value}
							onClick={() => setKind(value)}
						>
							{SUBTITLE_KIND_LABELS[value]}
						</button>
					))}
				</div>
				<label className={styles.field}>
					효과
					<select
						aria-label="자막 효과"
						value={style.animation}
						onChange={(event) =>
							setStyle({ animation: event.target.value as SubtitleStyle["animation"] })
						}
					>
						{SUBTITLE_EFFECTS.map((effect) => (
							<option key={effect.value} value={effect.value}>
								{effect.label}
							</option>
						))}
					</select>
				</label>
				<p className={styles.hint}>
					{SUBTITLE_EFFECTS.find((effect) => effect.value === style.animation)?.description}
				</p>
				<div className={styles.grid}>
					<NumberField
						label="글자 크기"
						value={style.fontSize}
						min={12}
						max={300}
						step={1}
						onCommit={(fontSize) => setStyle({ fontSize })}
					/>
					<NumberField
						label="기본 길이 (초)"
						value={style.durationSec}
						min={0.5}
						max={30}
						step={0.5}
						onCommit={(durationSec) =>
							void save((current) => patchSubtitleStyle(current, kind, { durationSec }))
						}
					/>
					<label className={styles.field}>
						글꼴
						<select
							aria-label="자막 글꼴"
							value={style.fontFamily}
							onChange={(event) => setStyle({ fontFamily: event.target.value })}
						>
							{SUBTITLE_FONTS.map((font) => (
								<option key={font.value} value={font.value}>
									{font.label}
								</option>
							))}
						</select>
					</label>
					<label className={styles.check}>
						<input
							type="checkbox"
							checked={style.bold}
							onChange={(event) => setStyle({ bold: event.target.checked })}
						/>
						굵게
					</label>
				</div>
				<ColorRow label="글자색" value={style.color} onCommit={(color) => setStyle({ color })} />
				<Segmented
					label="배경 상자"
					value={style.box}
					options={BOXES}
					onChange={(box) => setStyle({ box })}
				/>
				{style.box !== "none" ? (
					<ColorRow
						label="상자 색"
						value={style.boxColor}
						onCommit={(boxColor) => setStyle({ boxColor })}
					/>
				) : null}
				<Segmented
					label="위치"
					value={style.position}
					options={POSITIONS}
					onChange={(position) => setStyle({ position })}
				/>
				<p className={styles.hint}>
					바꾸면 이 프로젝트의 {SUBTITLE_KIND_LABELS[kind]} 모두에 바로 적용됩니다.
				</p>
			</section>

			<section className={styles.section} aria-label="자막 목록">
				<h3>
					자막 목록 <span>{entries.length}개</span>
				</h3>
				{entries.length === 0 ? (
					<p className={styles.note}>
						아직 없습니다. 영상을 재생하다 <kbd>N</kbd>을 누르고 글을 친 뒤 <kbd>Enter</kbd>, 이어서
						넣으려면
						<kbd>Ctrl</kbd>+<kbd>Enter</kbd>.
					</p>
				) : (
					<ol className={styles.list}>
						{entries.map((entry) => (
							<li key={entry.ids[0]} data-kind={entry.kind}>
								<button
									type="button"
									className={styles.entry}
									title="이 자막으로 가기"
									onClick={() => actions.reveal(entry)}
								>
									<span className={styles.time}>
										{formatSec(entry.startSec)}–{formatSec(entry.endSec)}
									</span>
									<span className={styles.badge}>{SUBTITLE_KIND_LABELS[entry.kind]}</span>
									<span className={styles.text}>{entry.text}</span>
								</button>
								<button
									type="button"
									className={styles.icon}
									aria-label={`${entry.text} 고치기`}
									title="고치기 (Enter)"
									onClick={() => actions.edit(entry.ids[0])}
								>
									<Pencil size={13} />
								</button>
								<button
									type="button"
									className={styles.icon}
									aria-label={`${entry.text} 지우기`}
									title="지우기"
									onClick={() => actions.remove(entry)}
								>
									<Trash2 size={13} />
								</button>
							</li>
						))}
					</ol>
				)}
			</section>

			<SubtitleImport disabled={!hasClips} />

			<section className={styles.section} aria-label="자막 단축키">
				<h3>단축키</h3>
				<dl className={styles.keys}>
					<dt>N / Shift+N</dt>
					<dd>재생 위치에 일반 자막 / 타이틀</dd>
					<dt>Enter · Shift+Enter</dt>
					<dd>넣기 · 줄 바꾸기</dd>
					<dt>Ctrl+Enter</dt>
					<dd>넣고 바로 다음 자막 쓰기</dd>
					<dt>Enter / F2</dt>
					<dd>선택한 자막 고치기</dd>
					<dt>[ / ]</dt>
					<dd>선택한 자막의 시작 / 끝을 재생 위치로</dd>
					<dt>Tab</dt>
					<dd>다음 자막 선택</dd>
				</dl>
			</section>
		</div>
	);
}

/** Pasted or opened SRT, VTT or plain text, as subtitles of one kind. */
function SubtitleImport({ disabled }: { disabled: boolean }) {
	const [text, setText] = useState("");
	const [kind, setKind] = useState<SubtitleKind>("caption");
	const file = useRef<HTMLInputElement>(null);

	const place = async () => {
		const parsed = parseSubtitleText(text);
		const start = useProjectStore.getState().currentTimeSec;
		const cues = "cues" in parsed ? parsed.cues : timeLines(parsed.lines, start);
		if (cues.length === 0) {
			toast.error("넣을 자막이 없습니다.", {
				description: "SRT·VTT를 붙여 넣거나, 한 줄에 자막 하나씩 적으세요.",
			});
			return;
		}
		let placed = 0;
		let dropped = 0;
		const saved = await save((current) => {
			const end = Math.max(0, ...current.timeline.clips.map((clip) => clip.timelineEndSec));
			const inside = cues.filter((cue) => cue.startSec < end);
			dropped = cues.length - inside.length;
			placed = inside.length;
			if (inside.length === 0) return current;
			return addSubtitles(
				current,
				inside.map((cue) => ({ ...cue, kind })),
				aspectOf(current),
			).document;
		});
		if (saved && placed > 0) {
			setText("");
			toast.success(`자막 ${placed}개를 넣었습니다.`, {
				description:
					dropped > 0
						? `영상이 끝난 뒤에 시작하는 ${dropped}개는 뺐습니다.`
						: "cues" in parsed
							? "파일의 시간을 그대로 썼습니다."
							: `재생 위치 ${formatSeconds(start)}부터 줄마다 읽을 만큼씩 놓았습니다.`,
			});
		} else if (placed === 0) toast.error("영상이 끝난 뒤에 시작하는 자막뿐입니다.");
	};

	return (
		<section className={styles.section} aria-label="자막 가져오기">
			<h3>가져오기</h3>
			<textarea
				aria-label="가져올 자막"
				placeholder={
					"SRT·VTT를 붙여 넣거나, 한 줄에 자막 하나씩 적으세요.\n시간이 없는 줄은 재생 위치부터 차례로 놓입니다."
				}
				rows={5}
				value={text}
				onChange={(event) => setText(event.target.value)}
			/>
			<div className={styles.importRow}>
				<select
					aria-label="가져올 자막 종류"
					value={kind}
					onChange={(event) => setKind(event.target.value as SubtitleKind)}
				>
					<option value="caption">일반 자막으로</option>
					<option value="title">타이틀로</option>
				</select>
				<button type="button" className={styles.ghost} onClick={() => file.current?.click()}>
					<FileUp size={14} />
					파일 열기
				</button>
				<input
					ref={file}
					type="file"
					accept=".srt,.vtt,.txt,text/plain"
					hidden
					onChange={(event) => {
						const picked = event.target.files?.[0];
						event.target.value = "";
						if (!picked) return;
						if (picked.size > 1_000_000) {
							toast.error("자막 파일은 1MB 이하로 골라 주세요.");
							return;
						}
						void picked.text().then(setText);
					}}
				/>
				<button
					type="button"
					className={styles.primary}
					disabled={disabled || !text.trim()}
					onClick={() => void place()}
				>
					자막으로 넣기
				</button>
			</div>
		</section>
	);
}

function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		<div className={styles.segmentedRow}>
			<span>{label}</span>
			<div className={styles.segmented} role="group" aria-label={label}>
				{options.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={value === option.value}
						onClick={() => onChange(option.value)}
					>
						{option.label}
					</button>
				))}
			</div>
		</div>
	);
}

/** Swatches, and a picker whose value is written once it is let go of. */
function ColorRow({
	label,
	value,
	onCommit,
}: {
	label: string;
	value: string;
	onCommit: (color: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<div className={styles.segmentedRow}>
			<span>{label}</span>
			<div className={styles.swatches} role="group" aria-label={label}>
				{SWATCHES.map((swatch) => (
					<button
						key={swatch}
						type="button"
						aria-label={`${label} ${swatch}`}
						aria-pressed={value.toLowerCase() === swatch}
						style={{ background: swatch }}
						onClick={() => onCommit(swatch)}
					/>
				))}
				<input
					type="color"
					aria-label={`${label} 직접 고르기`}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => {
						if (draft.toLowerCase() !== value.toLowerCase()) onCommit(draft);
					}}
				/>
			</div>
		</div>
	);
}

function NumberField({
	label,
	value,
	min,
	max,
	step,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onCommit: (value: number) => void;
}) {
	const shown = String(Math.round(value * 100) / 100);
	const [draft, setDraft] = useState(shown);
	useEffect(() => setDraft(shown), [shown]);
	const commit = () => {
		const parsed = Number(draft);
		if (draft.trim() !== "" && Number.isFinite(parsed) && Math.abs(parsed - value) > 0.001)
			onCommit(Math.min(max, Math.max(min, parsed)));
		else setDraft(shown);
	};
	return (
		<label className={styles.field}>
			{label}
			<input
				type="number"
				aria-label={label}
				min={min}
				max={max}
				step={step}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
		</label>
	);
}

/**
 * The quick bar over the preview: type, Enter to put the subtitle in, Shift+Enter for a second
 * line, Ctrl+Enter to put it in and start the next one where it ends, Esc to close.
 */
export function SubtitleQuickBar({
	draft,
	durationSec,
	rightInsetPx = 0,
	onText,
	onKind,
	onCommit,
	onClose,
}: {
	draft: SubtitleDraft;
	/** How long a new one of this kind lasts. */
	durationSec: number;
	/** What the inspector covers on the stage's right: the bar centres on the preview. */
	rightInsetPx?: number;
	onText: (text: string) => void;
	onKind: (kind: SubtitleKind) => void;
	onCommit: (next: boolean) => void;
	onClose: () => void;
}) {
	const field = useRef<HTMLTextAreaElement>(null);
	// Focus on opening and after each one put in, so typing can simply go on.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refocus whenever a new draft starts
	useEffect(() => {
		field.current?.focus();
	}, [draft.startSec, draft.editId, draft.kind]);
	const editing = draft.editId !== undefined;
	return (
		<div
			className={styles.bar}
			role="dialog"
			aria-label={editing ? "자막 고치기" : "자막 넣기"}
			style={{
				left: `calc(50% - ${rightInsetPx / 2}px)`,
				width: `min(720px, calc(100% - ${rightInsetPx + 48}px))`,
			}}
		>
			<div className={styles.barHead}>
				{editing ? (
					<span className={styles.badge}>{SUBTITLE_KIND_LABELS[draft.kind]} 고치기</span>
				) : (
					<div className={styles.kinds} role="group" aria-label="자막 종류">
						{(["caption", "title"] as const).map((value) => (
							<button
								key={value}
								type="button"
								aria-pressed={draft.kind === value}
								onClick={() => onKind(value)}
							>
								{SUBTITLE_KIND_LABELS[value]}
							</button>
						))}
					</div>
				)}
				<span className={styles.barTime}>
					{editing
						? `${formatSeconds(draft.startSec)}의 자막`
						: `${formatSeconds(draft.startSec)}부터 ${formatSeconds(durationSec)}`}
				</span>
				<button
					type="button"
					className={styles.icon}
					aria-label="닫기"
					title="닫기 (Esc)"
					onClick={onClose}
				>
					<X size={14} />
				</button>
			</div>
			<textarea
				ref={field}
				aria-label="자막 내용"
				rows={2}
				value={draft.text}
				placeholder={draft.kind === "title" ? "타이틀을 입력하세요" : "자막을 입력하세요"}
				onChange={(event) => onText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					} else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						onCommit(!editing && (event.ctrlKey || event.metaKey));
					}
				}}
			/>
			<div className={styles.barFoot}>
				<span>
					<kbd>Enter</kbd> {editing ? "저장" : "넣기"} · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄 바꾸기
					{editing ? "" : " · "}
					{editing ? null : (
						<>
							<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 넣고 다음 자막
						</>
					)}{" "}
					· <kbd>Esc</kbd> 닫기
				</span>
				<button
					type="button"
					className={styles.primary}
					disabled={!draft.text.trim()}
					onClick={() => onCommit(false)}
				>
					{editing ? "저장" : "넣기"}
				</button>
			</div>
		</div>
	);
}
