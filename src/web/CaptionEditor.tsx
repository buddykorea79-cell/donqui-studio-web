import { useRef, useState } from "react";
import { DEFAULT_CAPTION_STYLE, type WebCaption, type WebCaptionStyle } from "./captions";
import { formatTime } from "./media";
import type { WebProject } from "./project";

export function CaptionEditor({
	project,
	time,
	duration,
	onChange,
	onSeek,
	onImport,
	onExport,
}: {
	project: WebProject;
	time: number;
	duration: number;
	onChange: (change: Partial<WebProject>) => void;
	onSeek: (time: number) => void;
	onImport: (file: File) => void;
	onExport: () => void;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const captions = project.captions ?? [];
	const selected = captions.find((cue) => cue.id === selectedId) ?? captions[0];
	const style = project.captionStyle ?? DEFAULT_CAPTION_STYLE;
	const changeStyle = (change: Partial<WebCaptionStyle>) =>
		onChange({ captionStyle: { ...style, ...change } });
	const updateCue = (change: Partial<WebCaption>) => {
		if (!selected) return;
		onChange({
			captions: captions.map((cue) => (cue.id === selected.id ? { ...cue, ...change } : cue)),
		});
	};
	const addCue = () => {
		const startMs = Math.round(Math.min(time, Math.max(0, duration - 0.1)) * 1000);
		const cue: WebCaption = {
			id: crypto.randomUUID(),
			text: "새 자막",
			startMs,
			endMs: Math.max(startMs + 1, Math.round(Math.min(duration, startMs / 1000 + 2) * 1000)),
			timestampMs: null,
			confidence: null,
		};
		onChange({ captions: [...captions, cue] });
		setSelectedId(cue.id);
		onSeek(startMs / 1000);
	};
	return (
		<details className="caption-editor" open>
			<summary>
				자막 편집 <span>{captions.length}개 시간 자막</span>
			</summary>
			<p className="field-note">클립 자막과 시간 자막에 같은 스타일을 적용합니다.</p>
			<div className="caption-tools">
				<button type="button" onClick={() => fileInput.current?.click()}>
					SRT 가져오기
				</button>
				<button
					type="button"
					onClick={onExport}
					disabled={
						!captions.some((cue) => cue.text.trim()) &&
						!project.clips.some((clip) => clip.caption.trim())
					}
				>
					SRT 저장
				</button>
			</div>
			<input
				ref={fileInput}
				type="file"
				accept=".srt,application/x-subrip,text/plain"
				aria-label="SRT 자막 파일"
				hidden
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (file) onImport(file);
				}}
			/>
			<p className="field-note">
				SRT를 가져오면 시간 자막이 교체됩니다. 실행 취소로 복원할 수 있어요.
			</p>
			<button
				type="button"
				className="caption-add"
				onClick={addCue}
				disabled={!duration || captions.length >= 10_000}
			>
				현재 위치에 자막 추가
			</button>
			{selected && (
				<>
					<label className="field">
						<span>시간 자막 선택</span>
						<select
							value={selected.id}
							onChange={(event) => {
								setSelectedId(event.target.value);
								const cue = captions.find((item) => item.id === event.target.value);
								if (cue) onSeek(Math.min(duration, cue.startMs / 1000));
							}}
						>
							{captions.map((cue, index) => (
								<option key={cue.id} value={cue.id}>
									{index + 1}. {formatTime(cue.startMs / 1000)} ·{" "}
									{cue.text.slice(0, 40) || "빈 자막"}
								</option>
							))}
						</select>
					</label>
					<label className="field">
						<span>시간 자막 내용</span>
						<textarea
							rows={3}
							maxLength={5_000}
							value={selected.text}
							onChange={(event) => updateCue({ text: event.target.value })}
						/>
					</label>
					<div className="caption-time-fields">
						<label className="field">
							<span>자막 시작 (초)</span>
							<input
								type="number"
								min={0}
								max={(selected.endMs - 1) / 1000}
								step={0.1}
								value={selected.startMs / 1000}
								onChange={(event) => {
									const seconds = event.currentTarget.valueAsNumber;
									if (Number.isFinite(seconds))
										updateCue({
											startMs: Math.max(
												0,
												Math.min(selected.endMs - 1, Math.round(seconds * 1000)),
											),
										});
								}}
							/>
						</label>
						<label className="field">
							<span>자막 끝 (초)</span>
							<input
								type="number"
								min={(selected.startMs + 1) / 1000}
								max={86_400}
								step={0.1}
								value={selected.endMs / 1000}
								onChange={(event) => {
									const seconds = event.currentTarget.valueAsNumber;
									if (Number.isFinite(seconds))
										updateCue({
											endMs: Math.min(
												86_400_000,
												Math.max(selected.startMs + 1, Math.round(seconds * 1000)),
											),
										});
								}}
							/>
						</label>
					</div>
					<button
						type="button"
						className="delete-button"
						onClick={() => onChange({ captions: captions.filter((cue) => cue.id !== selected.id) })}
					>
						선택 자막 삭제
					</button>
				</>
			)}
			<label className="field">
				<span>자막 위치</span>
				<select
					value={style.position}
					onChange={(event) =>
						changeStyle({ position: event.target.value as WebCaptionStyle["position"] })
					}
				>
					<option value="bottom">아래</option>
					<option value="center">가운데</option>
					<option value="top">위</option>
				</select>
			</label>
			<label className="field">
				<span>
					자막 크기 <b>{Math.round(style.fontSize * 1000) / 10}%</b>
				</span>
				<input
					type="range"
					min={2}
					max={10}
					step={0.1}
					value={style.fontSize * 100}
					onChange={(event) => changeStyle({ fontSize: Number(event.target.value) / 100 })}
				/>
			</label>
			<label className="field">
				<span>자막 색상</span>
				<input
					type="color"
					value={style.color}
					onChange={(event) => changeStyle({ color: event.target.value })}
				/>
			</label>
			<label className="caption-background">
				<input
					type="checkbox"
					checked={style.background}
					onChange={(event) => changeStyle({ background: event.target.checked })}
				/>
				자막 배경 표시
			</label>
		</details>
	);
}
