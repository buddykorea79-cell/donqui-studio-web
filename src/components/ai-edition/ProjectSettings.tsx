import { toast } from "sonner";
import { useEditorDialogActions, useEditorDialogSection } from "@/contexts/EditorDialogsContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import {
	type Framing,
	getFraming,
	getOutputSettings,
	type MediaFit,
	OUTPUT_FPS,
	OUTPUT_RESOLUTIONS,
	type OutputDefaults,
	type OutputSettings,
	outputFrameSize,
	patchOutputSettings,
	projectOutputFrame,
	RESOLUTION_LABELS,
	rememberOutputDefaults,
	withFraming,
} from "@/lib/ai-edition/store/outputSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { mutateDocument } from "@/lib/media-board/mutate";
import { type AspectRatio, getAspectRatioValue } from "@/utils/aspectRatioUtils";
import { ModalShell } from "./Modals";
import styles from "./ProjectSettings.module.css";
import { PROJECT_SETTINGS_TITLE } from "./projectSettingsTitle";

const ASPECTS: Array<{ value: AspectRatio; label: string; note: string }> = [
	{ value: "16:9", label: "16:9 가로", note: "유튜브 · TV" },
	{ value: "9:16", label: "9:16 세로", note: "쇼츠 · 릴스 · 틱톡" },
	{ value: "4:3", label: "4:3", note: "클래식 화면" },
	{ value: "1:1", label: "1:1 정사각형", note: "피드" },
	{ value: "4:5", label: "4:5 세로", note: "인스타그램 피드" },
];

const FRAMINGS: Array<{ value: Framing; label: string; note: string }> = [
	{
		value: "full",
		label: "꽉 채우기",
		note: "영상과 사진이 화면 전체를 채웁니다. 여백·둥근 모서리가 없습니다.",
	},
	{
		value: "floating",
		label: "배경 위에 띄우기",
		note: "화면 녹화처럼 배경 위에 여백과 둥근 모서리를 두고 띄웁니다.",
	},
];

const FITS: Array<{ value: MediaFit; label: string; note: string }> = [
	{ value: "cover", label: "화면 가득", note: "비율이 다른 사진·영상은 가장자리가 조금 잘립니다." },
	{
		value: "contain",
		label: "전체 보이기",
		note: "잘리지 않는 대신 비율이 다르면 위아래나 옆에 여백이 생깁니다.",
	},
];

function saveChange(change: (document: AxcutDocument) => AxcutDocument, remember: OutputDefaults) {
	rememberOutputDefaults(remember);
	void mutateDocument(change, { history: true }).catch((error: unknown) =>
		toast.error("설정을 저장하지 못했습니다.", {
			description: error instanceof Error ? error.message : String(error),
		}),
	);
}

/** A small frame in the ratio's own shape, so the choice reads before its label does. */
function Shape({ ratio }: { ratio: number }) {
	const box = 30;
	const width = ratio >= 1 ? box : Math.round(box * ratio);
	const height = ratio >= 1 ? Math.round(box / ratio) : box;
	return (
		<span className={styles.shape} aria-hidden>
			<span style={{ width, height }} />
		</span>
	);
}

/**
 * Settings for the video being made: the frame's shape and resolution, its frame rate, and how
 * footage and photos sit in it. They belong to the open project — Export opens on them and Media
 * renders at them — and a new project starts from the ones chosen last.
 */
export function ProjectSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
	const document = useProjectStore((state) => state.document);
	const aspectRatio = getEditorSettings(document).aspectRatio;
	const output: OutputSettings = getOutputSettings(document);
	const framing = getFraming(document);
	const frame = projectOutputFrame(document);

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={PROJECT_SETTINGS_TITLE}
			subtitle="만들 영상의 화면 비율과 화질을 정합니다. 지금 연 프로젝트에 적용되고, 새 프로젝트도 이 설정으로 시작합니다."
			wide
		>
			{!document ? (
				<p className={styles.empty}>프로젝트를 열거나 새로 만들면 설정할 수 있습니다.</p>
			) : (
				<div className={styles.body}>
					<section className={styles.section} aria-label="화면 비율">
						<h3>화면 비율</h3>
						<div className={styles.choices}>
							{ASPECTS.map((aspect) => (
								<button
									key={aspect.value}
									type="button"
									className={styles.choice}
									aria-pressed={aspectRatio === aspect.value}
									onClick={() =>
										saveChange(
											(current) => patchEditorSettings(current, { aspectRatio: aspect.value }),
											{ aspectRatio: aspect.value },
										)
									}
								>
									<Shape ratio={getAspectRatioValue(aspect.value)} />
									<strong>{aspect.label}</strong>
									<small>{aspect.note}</small>
								</button>
							))}
						</div>
						<p className={styles.hint}>
							이미 Edit에 반영한 효과 클립과 사진은 Media에서 ‘Edit에 반영’을 다시 누르면 새 비율과
							화질로 다시 만들어집니다.
						</p>
					</section>

					<section className={styles.section} aria-label="화질">
						<h3>화질 (해상도)</h3>
						<div className={styles.choices}>
							{OUTPUT_RESOLUTIONS.map((resolution) => {
								const size = outputFrameSize(frame.width / frame.height, resolution);
								return (
									<button
										key={resolution}
										type="button"
										className={styles.choice}
										aria-pressed={output.resolution === resolution}
										onClick={() =>
											saveChange((current) => patchOutputSettings(current, { resolution }), {
												resolution,
											})
										}
									>
										<strong>{RESOLUTION_LABELS[resolution]}</strong>
										<small>
											{size.width} × {size.height}
										</small>
									</button>
								);
							})}
						</div>
						<p className={styles.hint}>
							내보내기 창이 이 화질로 열리고, Media의 효과 클립과 사진도 이 크기로 렌더링됩니다.
							4K는 렌더링이 오래 걸립니다.
						</p>
					</section>

					<section className={styles.section} aria-label="프레임">
						<h3>초당 프레임</h3>
						<div className={styles.choices}>
							{OUTPUT_FPS.map((fps) => (
								<button
									key={fps}
									type="button"
									className={styles.choice}
									aria-pressed={output.fps === fps}
									onClick={() =>
										saveChange((current) => patchOutputSettings(current, { fps }), { fps })
									}
								>
									<strong>{fps}fps</strong>
								</button>
							))}
						</div>
					</section>

					<section className={styles.section} aria-label="화면 구성">
						<h3>화면 구성</h3>
						<div className={`${styles.choices} ${styles.wide}`}>
							{FRAMINGS.map((choice) => (
								<button
									key={choice.value}
									type="button"
									className={styles.choice}
									aria-pressed={framing === choice.value}
									onClick={() =>
										saveChange((current) => withFraming(current, choice.value), {
											framing: choice.value,
										})
									}
								>
									<strong>{choice.label}</strong>
									<small>{choice.note}</small>
								</button>
							))}
						</div>
					</section>

					<section className={styles.section} aria-label="사진·영상 맞춤">
						<h3>사진·영상 맞춤 (Media)</h3>
						<div className={`${styles.choices} ${styles.wide}`}>
							{FITS.map((choice) => (
								<button
									key={choice.value}
									type="button"
									className={styles.choice}
									aria-pressed={output.mediaFit === choice.value}
									onClick={() =>
										saveChange(
											(current) => patchOutputSettings(current, { mediaFit: choice.value }),
											{ mediaFit: choice.value },
										)
									}
								>
									<strong>{choice.label}</strong>
									<small>{choice.note}</small>
								</button>
							))}
						</div>
					</section>

					<p className={styles.summary} role="status">
						최종 출력
						<strong>
							{frame.width} × {frame.height}
						</strong>
						<span>·</span>
						<strong>{output.fps}fps</strong>
						<span>·</span>
						<span>{framing === "full" ? "꽉 채우기" : "배경 위에 띄우기"}</span>
					</p>
				</div>
			)}
		</ModalShell>
	);
}

/** The one mount, beside the AI settings dialog in App.tsx, so the app menu opens it in every tab. */
export function ProjectSettingsDialog() {
	const section = useEditorDialogSection();
	const { closeDialog } = useEditorDialogActions();
	return <ProjectSettings open={section === "project"} onClose={closeDialog} />;
}
