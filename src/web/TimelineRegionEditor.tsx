import type { WebClip } from "./project";
import { type RegionSelection, regionEdgeBounds } from "./regionEditing";
import { clipSourceToOutputTime } from "./timelineEffects";

function ValueField({
	label,
	value,
	min,
	max,
	step = 0.1,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className="field">
			<span>{label}</span>
			<input
				type="number"
				min={min}
				max={max}
				step={step}
				value={Math.round(value * 1000) / 1000}
				onChange={(event) => {
					const next = event.currentTarget.valueAsNumber;
					if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
				}}
			/>
		</label>
	);
}

export function TimelineRegionEditor({
	clip,
	selection,
	onChange,
	onSeek,
	onClose,
}: {
	clip: WebClip;
	selection: RegionSelection;
	onChange: (change: Partial<WebClip>) => void;
	onSeek: (outputTime: number) => void;
	onClose: () => void;
}) {
	const zoom =
		selection.kind === "zoom"
			? clip.zoomRegions?.find((item) => item.id === selection.id)
			: undefined;
	const speed =
		selection.kind === "speed"
			? clip.speedRegions?.find((item) => item.id === selection.id)
			: undefined;
	const region = zoom ?? speed;
	if (!region) return null;
	const bounds = regionEdgeBounds(clip, selection.kind, region.id);
	const minLength = Math.min(0.05, region.end - region.start);
	const updateRange = (change: { start?: number; end?: number }) => {
		if (zoom)
			onChange({
				zoomRegions: clip.zoomRegions?.map((item) =>
					item.id === region.id
						? {
								...item,
								...change,
								easeInDuration: undefined,
								easeOutDuration: undefined,
								easeInOffset: undefined,
								easeOutOffset: undefined,
							}
						: item,
				),
			});
		else
			onChange({
				speedRegions: clip.speedRegions?.map((item) =>
					item.id === region.id ? { ...item, ...change } : item,
				),
			});
	};
	const updateZoom = (change: { scale?: number; focusX?: number; focusY?: number }) =>
		onChange({
			zoomRegions: clip.zoomRegions?.map((item) =>
				item.id === region.id ? { ...item, ...change } : item,
			),
		});
	return (
		<section className={`region-editor ${selection.kind}`} aria-label="타임라인 구간 편집">
			<div className="region-editor-heading">
				<h3>{zoom ? "돋보기 구간" : "속도 구간"}</h3>
				<button type="button" onClick={onClose} aria-label="구간 편집 닫기">
					닫기
				</button>
			</div>
			<div className="region-range-fields">
				<ValueField
					label="구간 시작 (초)"
					value={region.start}
					min={bounds.min}
					max={region.end - minLength}
					onChange={(start) => updateRange({ start })}
				/>
				<ValueField
					label="구간 끝 (초)"
					value={region.end}
					min={region.start + minLength}
					max={bounds.max}
					onChange={(end) => updateRange({ end })}
				/>
			</div>
			<p className="field-note">구간 시간은 배속 적용 전, 선택한 클립의 시작을 0초로 셉니다.</p>
			{zoom && (
				<>
					<ValueField
						label="확대 배율"
						value={zoom.scale}
						min={1}
						max={5}
						onChange={(scale) => updateZoom({ scale })}
					/>
					<div className="region-range-fields">
						<ValueField
							label="확대 중심 X (%)"
							value={zoom.focusX * 100}
							min={0}
							max={100}
							step={1}
							onChange={(value) => updateZoom({ focusX: value / 100 })}
						/>
						<ValueField
							label="확대 중심 Y (%)"
							value={zoom.focusY * 100}
							min={0}
							max={100}
							step={1}
							onChange={(value) => updateZoom({ focusY: value / 100 })}
						/>
					</div>
					<div className="focus-presets" role="group" aria-label="확대 위치">
						{[
							"왼쪽 위",
							"위",
							"오른쪽 위",
							"왼쪽",
							"가운데",
							"오른쪽",
							"왼쪽 아래",
							"아래",
							"오른쪽 아래",
						].map((name, index) => {
							const focusX = (index % 3) / 2;
							const focusY = Math.floor(index / 3) / 2;
							return (
								<button
									key={name}
									type="button"
									aria-label={`${name} 확대`}
									aria-pressed={zoom.focusX === focusX && zoom.focusY === focusY}
									onClick={() => updateZoom({ focusX, focusY })}
								>
									{name}
								</button>
							);
						})}
					</div>
				</>
			)}
			{speed && (
				<>
					<label className="field">
						<span>재생 속도</span>
						<select
							value={speed.rate}
							onChange={(event) =>
								onChange({
									speedRegions: clip.speedRegions?.map((item) =>
										item.id === speed.id ? { ...item, rate: Number(event.target.value) } : item,
									),
								})
							}
						>
							{[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((rate) => (
								<option key={rate} value={rate}>
									{rate}×{rate === 1 ? " · 원래 속도" : rate < 1 ? " · 느리게" : " · 빠르게"}
								</option>
							))}
							{![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(speed.rate) && (
								<option value={speed.rate}>{speed.rate}×</option>
							)}
						</select>
					</label>
					<p className="field-note">
						영상 소리의 높낮이도 배속에 따라 바뀝니다. 배경음악과 시간 자막은 완성 영상의 시간
						기준을 유지합니다.
					</p>
				</>
			)}
			<div className="region-editor-actions">
				<button
					type="button"
					onClick={() =>
						onSeek(
							(clipSourceToOutputTime(clip, region.start) +
								clipSourceToOutputTime(clip, region.end)) /
								2,
						)
					}
				>
					구간 미리보기
				</button>
				<button
					type="button"
					className="delete-button"
					onClick={() => {
						if (zoom)
							onChange({ zoomRegions: clip.zoomRegions?.filter((item) => item.id !== region.id) });
						else
							onChange({
								speedRegions: clip.speedRegions?.filter((item) => item.id !== region.id),
							});
						onClose();
					}}
				>
					구간 삭제
				</button>
			</div>
		</section>
	);
}
