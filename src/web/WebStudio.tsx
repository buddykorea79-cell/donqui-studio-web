import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	Download,
	Film,
	FolderOpen,
	Gauge,
	Image as ImageIcon,
	Info,
	Monitor,
	Music2,
	Pause,
	Play,
	Plus,
	Redo2,
	Save,
	Scissors,
	ShieldCheck,
	Square,
	Trash2,
	Undo2,
	Upload,
	X,
	ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLIP_EFFECTS, isClipEffectId, resolveClipEffect } from "../lib/clip-effects/catalog";
import { decodeWorkspace, encodeWorkspace } from "./archive";
import { CaptionEditor } from "./CaptionEditor";
import { parseSrt, stringifySrt } from "./captions";
import { downloadBlob, formatTime, importMedia } from "./media";
import { Preview } from "./Preview";
import {
	createAudio,
	createClip,
	createProject,
	fitClipsToDuration,
	getProjectCaptions,
	getProjectDuration,
	moveClip,
	type WebAsset,
	type WebAudio,
	type WebClip,
	type WebProject,
	type WebWorkspace,
} from "./project";
import { newRegionRange, type RegionKind, type RegionSelection } from "./regionEditing";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "./storage";
import { TimelineRegionEditor } from "./TimelineRegionEditor";
import {
	getClipOutputDuration,
	normalizeClipRegions,
	splitClipAtOutputTime,
} from "./timelineEffects";
import { useScreenRecording } from "./useScreenRecording";
import { VisualTimeline } from "./VisualTimeline";
import { hasSeenWebNotice, rememberWebNotice, WebVersionNotice } from "./WebVersionNotice";

const emptyWorkspace = (): WebWorkspace => ({ project: createProject(), assets: [] });
const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : "작업을 완료하지 못했습니다. 다시 시도해 주세요.";
const iconFor = (kind: WebAsset["kind"]) =>
	kind === "image" ? (
		<ImageIcon size={18} />
	) : kind === "audio" ? (
		<Music2 size={18} />
	) : (
		<Film size={18} />
	);

function NumberField({
	label,
	value,
	min = 0,
	max,
	onChange,
}: {
	label: string;
	value: number;
	min?: number;
	max?: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className="field">
			<span>{label}</span>
			<input
				type="number"
				step="0.1"
				min={min}
				max={max}
				value={Math.round(value * 100) / 100}
				onChange={(event) => {
					const next = event.currentTarget.valueAsNumber;
					if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max ?? 86_400, next)));
				}}
			/>
		</label>
	);
}

export function WebStudio() {
	const [workspace, setWorkspace] = useState<WebWorkspace>(emptyWorkspace);
	const current = useRef(workspace);
	current.current = workspace;
	const [ready, setReady] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saveState, setSaveState] = useState("불러오는 중");
	const [notice, setNotice] = useState("");
	const [importing, setImporting] = useState(false);
	const [filter, setFilter] = useState<"all" | WebAsset["kind"]>("all");
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedRegion, setSelectedRegion] = useState<RegionSelection | null>(null);
	const [time, setTime] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [progress, setProgress] = useState<number | null>(null);
	const [exportResult, setExportResult] = useState<{ blob: Blob; extension: string } | null>(null);
	const [showHelp, setShowHelp] = useState(() => !hasSeenWebNotice());
	const [past, setPast] = useState<WebWorkspace[]>([]);
	const [future, setFuture] = useState<WebWorkspace[]>([]);
	const [urls, setUrls] = useState(new Map<string, string>());
	const urlCache = useRef(new Map<string, { blob: Blob; url: string }>());
	const importInput = useRef<HTMLInputElement>(null);
	const backupInput = useRef<HTMLInputElement>(null);
	const exportAbort = useRef<AbortController | null>(null);
	const saveQueue = useRef(Promise.resolve());
	const generation = useRef(0);
	const { project, assets } = workspace;
	const duration = getProjectDuration(project);
	const onError = useCallback((error: unknown) => setNotice(messageOf(error)), []);
	const dismissWebNotice = () => {
		rememberWebNotice();
		setShowHelp(false);
	};

	useEffect(() => {
		let active = true;
		loadWorkspace()
			.then((saved) => {
				if (!active) return;
				if (saved) {
					setWorkspace(saved);
					current.current = saved;
				}
				setReady(true);
			})
			.catch((error) => {
				if (active) {
					onError(error);
					setLoadFailed(true);
				}
			});
		return () => {
			active = false;
		};
	}, [onError]);
	useEffect(() => {
		if (!ready) return;
		const revision = ++generation.current;
		setSaveState("저장 중…");
		const timer = window.setTimeout(() => {
			saveQueue.current = saveQueue.current
				.catch(() => undefined)
				.then(() => saveWorkspace(workspace))
				.then(() => {
					if (revision === generation.current) setSaveState("이 브라우저에 저장됨");
				})
				.catch((error) => {
					if (revision === generation.current) {
						setSaveState("저장 실패 · 백업 필요");
						onError(error);
					}
				});
		}, 600);
		return () => clearTimeout(timer);
	}, [workspace, ready, onError]);
	useEffect(() => {
		const cache = urlCache.current;
		const next = new Map<string, string>();
		for (const asset of assets) {
			let cached = cache.get(asset.id);
			if (!cached || cached.blob !== asset.blob) {
				if (cached) URL.revokeObjectURL(cached.url);
				cached = { blob: asset.blob, url: URL.createObjectURL(asset.blob) };
				cache.set(asset.id, cached);
			}
			next.set(asset.id, cached.url);
		}
		for (const [id, entry] of cache) {
			if (!next.has(id)) {
				URL.revokeObjectURL(entry.url);
				cache.delete(id);
			}
		}
		setUrls(next);
	}, [assets]);
	useEffect(
		() => () => {
			for (const entry of urlCache.current.values()) URL.revokeObjectURL(entry.url);
			urlCache.current.clear();
			exportAbort.current?.abort();
		},
		[],
	);
	useEffect(() => {
		if (!playing) return;
		let frame = 0;
		let previous = performance.now();
		const tick = (now: number) => {
			const delta = (now - previous) / 1_000;
			previous = now;
			setTime((value) => Math.min(duration, value + delta));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing, duration]);
	useEffect(() => {
		if (time >= duration) {
			setPlaying(false);
			setTime(duration);
		}
	}, [time, duration]);

	const commit = useCallback((next: WebWorkspace) => {
		const previous = current.current;
		setPast((items) => [...items.slice(-29), previous]);
		setFuture([]);
		const updated = { ...next, project: { ...next.project, updatedAt: new Date().toISOString() } };
		current.current = updated;
		setWorkspace(updated);
		setExportResult(null);
	}, []);
	const editProject = (change: Partial<WebProject>) =>
		commit({ ...workspace, project: { ...project, ...change } });
	const undo = () => {
		const previous = past[past.length - 1];
		if (!previous) return;
		setFuture((items) => [...items, workspace]);
		setPast(past.slice(0, -1));
		setWorkspace(previous);
		current.current = previous;
		setPlaying(false);
		setExportResult(null);
	};
	const redo = () => {
		const next = future[future.length - 1];
		if (!next) return;
		setPast((items) => [...items, workspace]);
		setFuture(future.slice(0, -1));
		setWorkspace(next);
		current.current = next;
		setPlaying(false);
		setExportResult(null);
	};
	const addAssetToTimeline = (asset: WebAsset) => {
		if (asset.kind === "audio") {
			const item = createAudio(asset);
			editProject({ audio: [...project.audio, item] });
			setSelected(item.id);
		} else {
			const item = createClip(asset);
			editProject({ clips: [...project.clips, item] });
			setSelected(item.id);
		}
	};
	const importFiles = useCallback(
		async (files: File[]) => {
			if (!files.length) return;
			setImporting(true);
			setPlaying(false);
			const imported: WebAsset[] = [];
			const failures: string[] = [];
			for (const file of files) {
				try {
					imported.push(await importMedia(file));
				} catch (error) {
					failures.push(messageOf(error));
				}
			}
			if (imported.length) {
				const original = current.current;
				commit({
					assets: [...original.assets, ...imported],
					project: {
						...original.project,
						clips: [
							...original.project.clips,
							...imported.filter((asset) => asset.kind !== "audio").map(createClip),
						],
						audio: [
							...original.project.audio,
							...imported.filter((asset) => asset.kind === "audio").map(createAudio),
						],
					},
				});
			}
			setNotice(
				failures.length
					? failures.join("\n")
					: `${imported.length}개 파일을 가져왔습니다. 타임라인에서 길이와 순서를 조정하세요.`,
			);
			setImporting(false);
		},
		[commit],
	);
	const recording = useScreenRecording((file) => {
		void importFiles([file]);
	}, onError);
	const busy = importing || progress !== null || recording.recording || recording.starting;
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (saveState !== "이 브라우저에 저장됨" || busy) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [saveState, busy]);
	useEffect(() => {
		const hide = () => {
			if (document.hidden) setPlaying(false);
		};
		document.addEventListener("visibilitychange", hide);
		return () => document.removeEventListener("visibilitychange", hide);
	}, []);

	const selectedClip = project.clips.find((item) => item.id === selected);
	const selectedAudio = project.audio.find((item) => item.id === selected);
	const selectedItem = selectedClip ?? selectedAudio;
	const selectedAsset = assets.find((item) => item.id === selectedItem?.assetId);
	const selectedClipStart = project.clips
		.slice(
			0,
			Math.max(
				0,
				project.clips.findIndex((clip) => clip.id === selected),
			),
		)
		.reduce((sum, clip) => sum + getClipOutputDuration(clip), 0);
	const updateClip = (change: Partial<WebClip>) =>
		editProject({
			clips: project.clips.map((clip) =>
				clip.id === selected ? normalizeClipRegions({ ...clip, ...change }) : clip,
			),
		});
	const addRegion = (kind: RegionKind) => {
		let start = 0;
		const clip = project.clips.find((item, index) => {
			if (time < start + getClipOutputDuration(item) || index === project.clips.length - 1)
				return true;
			start += getClipOutputDuration(item);
			return false;
		});
		if (!clip) return;
		const range = newRegionRange(clip, kind, time - start);
		setSelected(clip.id);
		setPlaying(false);
		if (range.existingId) {
			setSelectedRegion({ clipId: clip.id, kind, id: range.existingId });
			setNotice("현재 위치의 구간을 선택했습니다. 오른쪽에서 범위를 조절하세요.");
			return;
		}
		if (range.start === undefined || range.end === undefined || range.end - range.start < 0.01) {
			setNotice("구간을 넣을 빈 위치로 재생 위치를 옮겨 주세요.");
			return;
		}
		const id = crypto.randomUUID();
		const base = { id, start: range.start, end: range.end };
		const next =
			kind === "zoom"
				? {
						...clip,
						zoomRegions: [
							...(clip.zoomRegions ?? []),
							{ ...base, scale: 2, focusX: 0.5, focusY: 0.5 },
						],
					}
				: { ...clip, speedRegions: [...(clip.speedRegions ?? []), { ...base, rate: 2 }] };
		editProject({ clips: project.clips.map((item) => (item.id === clip.id ? next : item)) });
		setSelectedRegion({ clipId: clip.id, kind, id });
	};
	const updateAudio = (change: Partial<WebAudio>) =>
		editProject({
			audio: project.audio.map((item) => (item.id === selected ? { ...item, ...change } : item)),
		});
	const removeSelected = () => {
		editProject({
			clips: project.clips.filter((clip) => clip.id !== selected),
			audio: project.audio.filter((item) => item.id !== selected),
		});
		setSelected(null);
	};
	const splitClip = () => {
		if (!selectedClip) return;
		const index = project.clips.indexOf(selectedClip);
		const start = selectedClipStart;
		const offset = time - start;
		if (offset < 0.1 || offset > getClipOutputDuration(selectedClip) - 0.1) {
			setNotice("선택한 클립 안쪽으로 재생 위치를 옮긴 뒤 나누세요.");
			return;
		}
		const [first, second] = splitClipAtOutputTime(
			selectedClip,
			offset,
			crypto.randomUUID(),
			selectedAsset?.kind === "image",
		);
		editProject({
			clips: [...project.clips.slice(0, index), first, second, ...project.clips.slice(index + 1)],
		});
		setSelected(second.id);
		setSelectedRegion(null);
	};
	const fitToMusic = () => {
		try {
			const end = Math.max(0, ...project.audio.map((item) => item.start + item.duration));
			if (!end) throw new Error("먼저 음원을 추가해 주세요.");
			commit({ ...workspace, project: fitClipsToDuration(project, assets, end) });
			setNotice("영상·사진 길이를 음원 끝에 맞췄습니다.");
		} catch (error) {
			onError(error);
		}
	};
	const importSubtitles = async (file: File) => {
		setImporting(true);
		setPlaying(false);
		try {
			if (file.size > 5_000_000) throw new Error("자막 파일은 5MB 이하로 가져와 주세요.");
			const captions = parseSrt(await file.text());
			const original = current.current;
			commit({ ...original, project: { ...original.project, captions } });
			setNotice(
				`${captions.length}개 시간 자막을 가져왔습니다. 영상 구간 안의 자막이 미리보기와 내보내기에 표시됩니다.`,
			);
		} catch (error) {
			onError(error);
		} finally {
			setImporting(false);
		}
	};
	const exportSubtitles = () => {
		try {
			downloadBlob(
				new Blob([stringifySrt(getProjectCaptions(project))], {
					type: "application/x-subrip;charset=utf-8",
				}),
				`${project.title}.srt`,
			);
		} catch (error) {
			onError(error);
		}
	};
	const exportMovie = async () => {
		if (!project.clips.length || busy) return;
		setPlaying(false);
		setProgress(0);
		setExportResult(null);
		const controller = new AbortController();
		exportAbort.current = controller;
		try {
			const { exportVideo } = await import("./exportVideo");
			const result = await exportVideo(project, assets, {
				signal: controller.signal,
				onProgress: setProgress,
			});
			setExportResult(result);
			downloadBlob(result.blob, `${project.title}.${result.extension}`);
			setNotice(
				`${result.extension.toUpperCase()} 파일을 만들었습니다. 다운로드가 시작되지 않으면 다시 다운로드를 눌러 주세요.`,
			);
		} catch (error) {
			if (!controller.signal.aborted) onError(error);
			else setNotice("영상 내보내기를 취소했습니다.");
		} finally {
			setProgress(null);
			exportAbort.current = null;
		}
	};
	const openBackup = async (file: File) => {
		setImporting(true);
		try {
			const restored = await decodeWorkspace(file);
			if (
				workspace.assets.length &&
				!window.confirm(
					"현재 작업을 백업 파일의 작업으로 바꿀까요? 실행 취소로 돌아갈 수 있습니다.",
				)
			)
				return;
			commit(restored);
			setTime(0);
			setSelected(null);
			setPlaying(false);
			setNotice("미디어와 편집 내용을 백업에서 복원했습니다.");
		} catch (error) {
			onError(error);
		} finally {
			setImporting(false);
		}
	};
	const startOver = async () => {
		if (!window.confirm("새 프로젝트를 시작할까요? 현재 작업은 먼저 백업 저장을 권장합니다."))
			return;
		if (loadFailed) {
			try {
				await clearWorkspace();
			} catch (error) {
				onError(error);
			}
		}
		commit(emptyWorkspace());
		setTime(0);
		setPlaying(false);
		setSelected(null);
		setReady(true);
		setLoadFailed(false);
	};
	if (!ready)
		return (
			<main className="boot-screen">
				<img src="/donqui.svg" alt="Donqui Studio" width="60" />
				<h1>{loadFailed ? "저장된 작업을 열 수 없습니다" : "Donqui Studio를 여는 중"}</h1>
				<p>{notice || "이 브라우저에 저장된 미디어와 편집 내용을 불러옵니다."}</p>
				{loadFailed && (
					<button type="button" onClick={startOver}>
						새 작업으로 시작
					</button>
				)}
			</main>
		);
	const filteredAssets = assets.filter((asset) => filter === "all" || asset.kind === filter);
	return (
		<main
			className="studio"
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
				event.preventDefault();
				if (!busy) void importFiles(Array.from(event.dataTransfer.files));
			}}
		>
			<header className="topbar">
				<a className="brand" href="/" aria-label="Donqui Studio 홈">
					<img src="/donqui.svg" alt="" />
					<span>
						DONQUI<span className="brand-light">STUDIO</span>
					</span>
					<span className="web-badge">WEB</span>
				</a>
				<div className="project-heading">
					<input
						aria-label="프로젝트 이름"
						maxLength={100}
						value={project.title}
						disabled={busy}
						onChange={(event) => editProject({ title: event.target.value || "제목 없는 영상" })}
					/>
					<small>
						<span className={`status-dot ${saveState.includes("실패") ? "warning" : ""}`} />
						{saveState}
					</small>
				</div>
				<div className="header-actions">
					<button
						type="button"
						className="icon-button"
						title="도움말 및 웹 지원 범위"
						aria-label="도움말"
						onClick={() => setShowHelp(true)}
					>
						<Info size={19} />
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => {
							try {
								downloadBlob(encodeWorkspace(workspace), `${project.title}.donqui`);
							} catch (error) {
								onError(error);
							}
						}}
						disabled={busy}
					>
						<Save size={16} />
						백업 저장
					</button>
					<button
						type="button"
						className="primary"
						disabled={!project.clips.length || busy}
						onClick={exportMovie}
					>
						<Download size={17} />
						영상 내보내기
					</button>
				</div>
			</header>
			<div className="workspace-toolbar">
				<div>
					<span className="workspace-label">나의 작업 공간</span>
					<span className="separator" />
					<button type="button" onClick={startOver} disabled={busy}>
						<Plus size={15} />새 프로젝트
					</button>
					<button type="button" onClick={() => backupInput.current?.click()} disabled={busy}>
						<FolderOpen size={15} />
						백업 열기
					</button>
				</div>
				<span className="privacy-note">
					<ShieldCheck size={14} />
					미디어는 서버에 업로드되지 않습니다
				</span>
			</div>
			{notice && (
				<div className="notice" role="status">
					<span>{notice}</span>
					<button
						type="button"
						className="icon-button"
						aria-label="알림 닫기"
						onClick={() => setNotice("")}
					>
						<X size={16} />
					</button>
				</div>
			)}
			<input
				ref={importInput}
				className="hidden-input"
				type="file"
				multiple
				accept="image/*,video/*,audio/*,.mkv,.m4a"
				onChange={(event) => {
					void importFiles(Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
			/>
			<input
				ref={backupInput}
				className="hidden-input"
				type="file"
				accept=".donqui"
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) void openBackup(file);
					event.target.value = "";
				}}
			/>
			<div className="editor-grid">
				<aside className="library panel">
					<div className="panel-heading">
						<h2>미디어 라이브러리</h2>
						<span className="count">{assets.length}</span>
					</div>
					<button
						type="button"
						className="import-button"
						onClick={() => importInput.current?.click()}
						disabled={busy}
					>
						<Upload size={20} />
						<span>
							{importing ? "파일을 읽는 중…" : "미디어 가져오기"}
							<small>영상, 사진, 음악을 끌어 놓으세요</small>
						</span>
						<Plus size={18} />
					</button>
					<button
						type="button"
						className={`record-button ${recording.recording ? "is-recording" : ""}`}
						disabled={!recording.supported || (busy && !recording.recording)}
						onClick={recording.recording ? recording.stop : recording.start}
						title="HTTPS 또는 localhost에서 사용 가능합니다. 공유 오디오는 브라우저가 허용한 경우 녹음됩니다."
					>
						{recording.recording ? <Square size={14} fill="currentColor" /> : <Monitor size={16} />}
						{recording.recording
							? "녹화 중 · 눌러서 완료"
							: recording.starting
								? "공유할 화면 선택 중…"
								: "화면 녹화"}
					</button>
					<div className="library-filters" role="group" aria-label="미디어 종류">
						{(
							[
								["all", "전체"],
								["video", "영상"],
								["image", "사진"],
								["audio", "음원"],
							] as const
						).map(([key, label]) => (
							<button
								type="button"
								key={key}
								className={filter === key ? "active" : ""}
								onClick={() => setFilter(key)}
							>
								{label}
							</button>
						))}
					</div>
					<div className="asset-list">
						{filteredAssets.length ? (
							filteredAssets.map((asset) => (
								<div className="asset-card" key={asset.id}>
									<button
										type="button"
										className="asset-add"
										disabled={busy}
										onClick={() => addAssetToTimeline(asset)}
										title="타임라인에 추가"
									>
										<span className={`asset-thumb ${asset.kind}`}>
											{asset.kind === "image" ? (
												<img src={urls.get(asset.id)} alt="" />
											) : (
												iconFor(asset.kind)
											)}
										</span>
										<span className="asset-info">
											<strong>{asset.name}</strong>
											<small>
												{asset.kind === "image" ? "사진" : formatTime(asset.duration)} ·{" "}
												{(asset.blob.size / 1024 / 1024).toFixed(1)} MB
											</small>
										</span>
										<Plus size={15} />
									</button>
									<button
										type="button"
										className="asset-delete"
										aria-label={`${asset.name} 미디어 삭제`}
										disabled={busy}
										onClick={() => {
											if (
												project.clips.some((item) => item.assetId === asset.id) ||
												project.audio.some((item) => item.assetId === asset.id)
											) {
												setNotice("타임라인에 사용 중인 미디어입니다. 클립을 먼저 삭제하세요.");
												return;
											}
											commit({
												...workspace,
												assets: assets.filter((item) => item.id !== asset.id),
											});
										}}
									>
										<Trash2 size={13} />
									</button>
								</div>
							))
						) : (
							<div className="library-empty">
								<FolderOpen size={30} />
								<p>이야기의 재료를 모아 보세요</p>
								<small>원본 파일은 그대로 유지됩니다.</small>
							</div>
						)}
					</div>
					<div className="local-note">
						<ShieldCheck size={16} />
						<p>
							이 기기에서만 편집
							<small>
								브라우저 데이터 삭제 전에는
								<br />
								프로젝트를 백업해 주세요.
							</small>
						</p>
					</div>
				</aside>
				<section className="viewer panel">
					<div className="viewer-heading">
						<h2>미리보기</h2>
						<span>
							{project.width} × {project.height} <span className="dot-separator">·</span> 30 fps
						</span>
					</div>
					<div className="preview-area">
						{project.clips.length ? (
							<Preview
								project={project}
								assets={assets}
								urls={urls}
								time={time}
								playing={playing}
								onError={(message) => {
									setNotice(message);
									setPlaying(false);
								}}
							/>
						) : (
							<div className="empty-preview">
								<div className="empty-mark">
									<Film size={36} strokeWidth={1.3} />
								</div>
								<span className="eyebrow">YOUR NEXT STORY STARTS HERE</span>
								<h1>당신의 순간을, 한 편의 영상으로.</h1>
								<p>
									사진과 영상을 모으고, 음악에 맞춰 엮어 보세요.
									<br />
									설치 없이 이 브라우저에서 바로 시작합니다.
								</p>
								<button
									type="button"
									className="primary"
									onClick={() => importInput.current?.click()}
									disabled={busy}
								>
									<Plus size={17} />첫 미디어 가져오기
								</button>
								<div className="start-steps">
									<span>
										<b>01</b> 미디어 가져오기
									</span>
									<span>
										<b>02</b> 순서·길이 편집
									</span>
									<span>
										<b>03</b> 영상 다운로드
									</span>
								</div>
							</div>
						)}
					</div>
					<div className="playback">
						<span className="timecode">
							{formatTime(time)} <span>/ {formatTime(duration)}</span>
						</span>
						<button
							type="button"
							className="play-button"
							aria-label={playing ? "일시 정지" : "재생"}
							disabled={!duration || busy}
							onClick={() => {
								if (time >= duration) setTime(0);
								setPlaying(!playing);
							}}
						>
							{playing ? (
								<Pause size={18} fill="currentColor" />
							) : (
								<Play size={18} fill="currentColor" />
							)}
						</button>
						<span className="preview-tag">브라우저 미리보기</span>
					</div>
					<input
						className="scrubber"
						aria-label="재생 위치"
						type="range"
						min={0}
						max={duration || 1}
						step={0.01}
						value={time}
						disabled={!duration || busy}
						onChange={(event) => {
							setPlaying(false);
							setTime(Number(event.target.value));
						}}
					/>
				</section>
				<aside className="inspector panel">
					<div className="panel-heading">
						<h2>{selectedItem ? "클립 편집" : "프로젝트 설정"}</h2>
						{selectedItem && (
							<button
								type="button"
								className="icon-button"
								aria-label="선택 해제"
								onClick={() => setSelected(null)}
							>
								<X size={16} />
							</button>
						)}
					</div>
					<fieldset disabled={busy}>
						{selectedClip && selectedRegion?.clipId === selectedClip.id && (
							<TimelineRegionEditor
								clip={selectedClip}
								selection={selectedRegion}
								onChange={updateClip}
								onSeek={(position) => {
									setTime(selectedClipStart + position);
									setPlaying(false);
								}}
								onClose={() => setSelectedRegion(null)}
							/>
						)}
						<label className="field">
							<span>출력 크기</span>
							<select
								value={`${project.width}x${project.height}`}
								onChange={(event) => {
									const [width, height] = event.target.value.split("x").map(Number);
									editProject({ width, height });
								}}
							>
								<option value="1280x720">가로 16:9 · 720p</option>
								<option value="1920x1080">가로 16:9 · 1080p</option>
								<option value="720x1280">세로 9:16 · 720p</option>
								<option value="1080x1920">세로 9:16 · 1080p</option>
								<option value="1080x1080">정사각형 · 1080p</option>
								{!["1280x720", "1920x1080", "720x1280", "1080x1920", "1080x1080"].includes(
									`${project.width}x${project.height}`,
								) && (
									<option value={`${project.width}x${project.height}`}>
										{project.width} × {project.height} · 가져온 크기
									</option>
								)}
							</select>
						</label>
						<button
							type="button"
							className="caption-add"
							disabled={!project.clips.length}
							onClick={() =>
								editProject({
									clips: project.clips.map((clip) => ({
										...clip,
										effect: resolveClipEffect("random", crypto.randomUUID()),
									})),
								})
							}
						>
							클립마다 무작위 효과
						</button>
						{selectedItem && selectedAsset ? (
							<>
								<div className="inspector-divider" />
								<div className="selected-name">
									{iconFor(selectedAsset.kind)}
									<strong>{selectedAsset.name}</strong>
								</div>
								{selectedAudio && (
									<NumberField
										label="타임라인 시작 (초)"
										value={selectedAudio.start}
										onChange={(start) => updateAudio({ start })}
									/>
								)}
								{selectedAsset.kind !== "image" && (
									<NumberField
										label="원본 시작 위치 (초)"
										value={selectedItem.trimStart}
										max={Math.max(0, selectedAsset.duration - 0.1)}
										onChange={(trimStart) => {
											const change = {
												trimStart,
												duration: Math.min(
													selectedItem.duration,
													selectedAsset.duration - trimStart,
												),
											};
											if (selectedClip) updateClip(change);
											else updateAudio(change);
										}}
									/>
								)}
								<NumberField
									label={selectedClip ? "원본 구간 길이 (초)" : "클립 길이 (초)"}
									min={Math.min(0.1, selectedAsset.duration || 0.1)}
									max={
										selectedAsset.kind === "image"
											? 3600
											: selectedAsset.duration - selectedItem.trimStart
									}
									value={selectedItem.duration}
									onChange={(value) =>
										selectedClip
											? updateClip({ duration: value })
											: updateAudio({ duration: value })
									}
								/>
								{selectedAsset.kind !== "image" && (
									<label className="field">
										<span>
											음량 <b>{Math.round(selectedItem.volume * 100)}%</b>
										</span>
										<input
											type="range"
											min={0}
											max={1}
											step={0.01}
											value={selectedItem.volume}
											onChange={(event) =>
												selectedClip
													? updateClip({ volume: Number(event.target.value) })
													: updateAudio({ volume: Number(event.target.value) })
											}
										/>
									</label>
								)}
								{selectedClip && (
									<>
										<p className="field-note">
											완성 영상에서 {formatTime(getClipOutputDuration(selectedClip))} 재생됩니다.
											돋보기·속도는 타임라인에서 구간을 추가하세요.
										</p>
										<label className="field">
											<span>Remotion 효과</span>
											<select
												value={selectedClip.effect}
												onChange={(event) => {
													if (isClipEffectId(event.target.value))
														updateClip({ effect: event.target.value });
												}}
											>
												<option value="none">없음</option>
												{CLIP_EFFECTS.map((effect) => (
													<option key={effect.id} value={effect.id}>
														{effect.label}
													</option>
												))}
											</select>
										</label>
										<p className="field-note">
											{CLIP_EFFECTS.find((effect) => effect.id === selectedClip.effect)
												?.description ?? "원본 화면을 그대로 보여 줍니다"}
										</p>
										<label className="field">
											<span>화면 맞춤</span>
											<select
												value={selectedClip.fit ?? "contain"}
												onChange={(event) =>
													updateClip({ fit: event.target.value === "cover" ? "cover" : "contain" })
												}
											>
												<option value="contain">전체 보이기</option>
												<option value="cover">화면 채우기</option>
											</select>
										</label>
										<button
											type="button"
											className="caption-add"
											onClick={() =>
												editProject({
													clips: project.clips.map((clip) => ({
														...clip,
														effect: selectedClip.effect,
														fit: selectedClip.fit,
													})),
												})
											}
										>
											효과·화면 맞춤을 전체 클립에 적용
										</button>
										<label className="field">
											<span>자막</span>
											<textarea
												rows={3}
												maxLength={5_000}
												placeholder="이 장면의 이야기를 적어 보세요"
												value={selectedClip.caption}
												onChange={(event) => updateClip({ caption: event.target.value })}
											/>
										</label>
										<div className="clip-actions">
											<button
												type="button"
												onClick={() =>
													commit({ ...workspace, project: moveClip(project, selectedClip.id, -1) })
												}
												aria-label="클립 앞으로"
											>
												<ArrowLeft size={16} />
											</button>
											<button type="button" onClick={splitClip}>
												<Scissors size={15} />
												나누기
											</button>
											<button
												type="button"
												onClick={() =>
													commit({ ...workspace, project: moveClip(project, selectedClip.id, 1) })
												}
												aria-label="클립 뒤로"
											>
												<ArrowRight size={16} />
											</button>
										</div>
									</>
								)}
								<button type="button" className="delete-button" onClick={removeSelected}>
									<Trash2 size={15} />
									클립 삭제
								</button>
							</>
						) : (
							<div className="inspector-hint">
								<Scissors size={25} strokeWidth={1.3} />
								<p>
									타임라인에서 클립을 선택하면
									<br />
									길이, 효과, 자막을 편집할 수 있어요.
								</p>
								<div className="project-stats">
									<span>
										장면 수<strong>{project.clips.length}개</strong>
									</span>
									<span>
										음원 수<strong>{project.audio.length}개</strong>
									</span>
									<span>
										전체 길이<strong>{formatTime(duration)}</strong>
									</span>
								</div>
							</div>
						)}
						<CaptionEditor
							project={project}
							time={time}
							duration={duration}
							onChange={editProject}
							onSeek={(position) => {
								setTime(position);
								setPlaying(false);
							}}
							onImport={(file) => void importSubtitles(file)}
							onExport={exportSubtitles}
						/>
					</fieldset>
					<div className="inspector-footer">
						<Info size={14} />
						<span>
							웹에서는 수동 편집을 지원합니다.
							<br />
							AI 장면 분석·자동 자막은 데스크톱 기능입니다.
						</span>
					</div>
				</aside>
			</div>
			<section className="timeline panel">
				<div className="timeline-toolbar">
					<div>
						<h2>타임라인</h2>
						<button
							type="button"
							className="add-region-button"
							disabled={!project.clips.length || busy}
							onClick={() => addRegion("zoom")}
						>
							<ZoomIn size={15} />+ 돋보기
						</button>
						<button
							type="button"
							className="add-region-button"
							disabled={!project.clips.length || busy}
							onClick={() => addRegion("speed")}
						>
							<Gauge size={15} />+ 속도
						</button>
						<span className="separator" />
						<button
							type="button"
							className="icon-button"
							aria-label="실행 취소"
							title="실행 취소"
							disabled={!past.length || busy}
							onClick={undo}
						>
							<Undo2 size={17} />
						</button>
						<button
							type="button"
							className="icon-button"
							aria-label="다시 실행"
							title="다시 실행"
							disabled={!future.length || busy}
							onClick={redo}
						>
							<Redo2 size={17} />
						</button>
					</div>
					<button
						type="button"
						className="fit-button"
						disabled={!project.clips.length || !project.audio.length || busy}
						onClick={fitToMusic}
					>
						<Music2 size={15} />
						음악 길이에 맞추기
						<ArrowRight size={14} />
					</button>
				</div>
				{project.clips.length > 0 && (
					<VisualTimeline
						project={project}
						assets={assets}
						time={time}
						selectedClipId={selected}
						selection={selectedRegion}
						disabled={busy}
						onSelectClip={(id, start) => {
							setSelected(id);
							setSelectedRegion(null);
							setTime(start);
							setPlaying(false);
						}}
						onSelectRegion={(selection, position) => {
							setSelected(selection.clipId);
							setSelectedRegion(selection);
							setTime(position);
							setPlaying(false);
						}}
						onSeek={(position) => {
							setTime(position);
							setPlaying(false);
						}}
					/>
				)}
				<div className="timeline-content">
					{!project.clips.length && (
						<>
							<div className="track-label">
								<Film size={16} />
								<span>영상 · 사진</span>
							</div>
							<div className="clip-track">
								{!project.clips.length && (
									<button
										type="button"
										className="empty-track"
										disabled={busy}
										onClick={() => importInput.current?.click()}
									>
										<Plus size={17} />
										미디어를 가져와 첫 장면을 추가하세요
									</button>
								)}
							</div>
						</>
					)}
					<div className="track-label">
						<Music2 size={16} />
						<span>배경 음악</span>
					</div>
					<div className="audio-track">
						{project.audio.map((item) => (
							<button
								type="button"
								key={item.id}
								className={`audio-clip ${selected === item.id ? "selected" : ""}`}
								disabled={busy}
								onClick={() => {
									setSelected(item.id);
									setPlaying(false);
									setTime(Math.min(duration, item.start));
								}}
							>
								<Music2 size={16} />
								<strong>{assets.find((asset) => asset.id === item.assetId)?.name}</strong>
								<small>
									{formatTime(item.start)} → {formatTime(item.start + item.duration)}
								</small>
							</button>
						))}
						{!project.audio.length && (
							<span className="empty-audio">음원을 가져오면 여기에 추가됩니다</span>
						)}
					</div>
				</div>
			</section>
			<footer className="studio-footer">
				<span>
					DONQUI STUDIO <b>WEB</b>
				</span>
				<span>브라우저에 자동 저장 · 다른 기기에서는 백업 파일로 이어서 편집</span>
				{exportResult && (
					<button
						type="button"
						onClick={() =>
							downloadBlob(exportResult.blob, `${project.title}.${exportResult.extension}`)
						}
					>
						<ArrowDown size={13} />
						다시 다운로드
					</button>
				)}
			</footer>
			{progress !== null && (
				<div className="modal-backdrop">
					<section className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
						<span className="eyebrow">MADE ON YOUR DEVICE</span>
						<h2 id="export-title">영상을 만들고 있어요</h2>
						<p>이 탭을 열어 두세요. 영상과 음원을 브라우저에서 처리합니다.</p>
						<progress max={1} value={progress} />
						<strong className="export-percent">{Math.round(progress * 100)}%</strong>
						<button
							type="button"
							className="secondary"
							onClick={() => exportAbort.current?.abort()}
						>
							내보내기 취소
						</button>
					</section>
				</div>
			)}
			<WebVersionNotice open={showHelp} onDismiss={dismissWebNotice} />
		</main>
	);
}
