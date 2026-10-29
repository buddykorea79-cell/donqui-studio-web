import { Film, Gauge, ZoomIn } from "lucide-react";
import { formatTime } from "./media";
import { getProjectDuration, type WebAsset, type WebProject } from "./project";
import type { RegionSelection } from "./regionEditing";
import { clipSourceToOutputTime, getClipOutputDuration } from "./timelineEffects";

export function VisualTimeline({
	project,
	assets,
	time,
	selectedClipId,
	selection,
	disabled,
	onSelectClip,
	onSelectRegion,
	onSeek,
}: {
	project: WebProject;
	assets: WebAsset[];
	time: number;
	selectedClipId: string | null;
	selection: RegionSelection | null;
	disabled: boolean;
	onSelectClip: (id: string, start: number) => void;
	onSelectRegion: (selection: RegionSelection, start: number) => void;
	onSeek: (time: number) => void;
}) {
	const duration = getProjectDuration(project);
	let offset = 0;
	const clips = project.clips.map((clip) => {
		const start = offset;
		offset += getClipOutputDuration(clip);
		return { clip, start, end: offset };
	});
	const position = (start: number, end: number) => ({
		left: `${(start / duration) * 100}%`,
		width: `${((end - start) / duration) * 100}%`,
	});
	return (
		<div className="visual-timeline" aria-label="영상 효과 타임라인">
			<div
				className="visual-timeline-grid"
				style={{ minWidth: Math.min(12000, Math.max(650, duration * 35, clips.length * 120)) }}
			>
				<span className="track-label">완성 영상 시간</span>
				<div className="timeline-ruler">
					{Array.from({ length: 6 }, (_, index) => (
						<button
							type="button"
							key={index}
							disabled={disabled}
							onClick={() => onSeek((duration * index) / 5)}
						>
							{formatTime((duration * index) / 5)}
						</button>
					))}
				</div>
				<div className="track-label">
					<Film size={16} />
					영상 · 사진
				</div>
				<div className="visual-track clip-lane">
					{clips.map(({ clip, start, end }, index) => (
						<button
							type="button"
							key={clip.id}
							disabled={disabled}
							className={`timeline-clip ${selectedClipId === clip.id ? "selected" : ""}`}
							style={position(start, end)}
							title={`${assets.find((asset) => asset.id === clip.assetId)?.name ?? "미디어"} · ${formatTime(end - start)}`}
							onClick={() => onSelectClip(clip.id, start)}
						>
							<span className="clip-number">{String(index + 1).padStart(2, "0")}</span>
							<strong>{assets.find((asset) => asset.id === clip.assetId)?.name ?? "미디어"}</strong>
							<small>
								{formatTime(end - start)}
								{clip.caption && " · 자막"}
							</small>
						</button>
					))}
					<span
						className="timeline-playhead"
						style={{ left: `${Math.min(1, time / duration) * 100}%` }}
					/>
				</div>
				{(["zoom", "speed"] as const).map((kind) => (
					<div className="timeline-row" key={kind}>
						<div className="track-label">
							{kind === "zoom" ? <ZoomIn size={16} /> : <Gauge size={16} />}
							{kind === "zoom" ? "돋보기" : "속도"}
						</div>
						<div className={`visual-track region-lane ${kind}`}>
							{!clips.some(
								({ clip }) => (kind === "zoom" ? clip.zoomRegions : clip.speedRegions)?.length,
							) && (
								<span className="region-lane-hint">
									위의 + 버튼으로 현재 위치에 구간을 추가하세요
								</span>
							)}
							{clips.flatMap(({ clip, start }) =>
								(kind === "zoom" ? (clip.zoomRegions ?? []) : (clip.speedRegions ?? [])).map(
									(region) => {
										const begin = start + clipSourceToOutputTime(clip, region.start);
										const end = start + clipSourceToOutputTime(clip, region.end);
										const label =
											"scale" in region ? `돋보기 ${region.scale}×` : `속도 ${region.rate}×`;
										return (
											<button
												type="button"
												disabled={disabled}
												key={`${clip.id}-${region.id}`}
												className={`timeline-region ${selection?.clipId === clip.id && selection.id === region.id && selection.kind === kind ? "selected" : ""}`}
												style={position(begin, end)}
												title={`${label} · ${formatTime(begin)} ~ ${formatTime(end)}`}
												aria-label={`${label} 구간 ${formatTime(begin)}부터`}
												onClick={() =>
													onSelectRegion(
														{ clipId: clip.id, kind, id: region.id },
														(begin + end) / 2,
													)
												}
											>
												{label}
											</button>
										);
									},
								),
							)}
							<span
								className="timeline-playhead"
								style={{ left: `${Math.min(1, time / duration) * 100}%` }}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
