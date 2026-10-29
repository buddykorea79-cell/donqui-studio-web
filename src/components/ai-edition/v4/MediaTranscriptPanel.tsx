import { RotateCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import type { AxcutAsset, TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import {
	languageLabel,
	sortedLanguageOptions,
} from "@/lib/ai-edition/transcription/languageLabels";
import {
	type AssetTranscriptionView,
	isSilentFailure,
} from "@/lib/ai-edition/transcription/status";
import {
	TranscriptionProgressBar,
	TranscriptionStatusDot,
	useTranscriptionLabel,
} from "../TranscriptionStatus";
import styles from "./MediaStage.module.css";

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/**
 * A video's transcript: where the background transcription is at, the language it detected,
 * and a re-run in another language. Transcripts are produced as soon as a media lands in the
 * project (see transcriptionStore); this only reports and re-runs.
 */
export function MediaTranscriptPanel({
	asset,
	onClose,
}: {
	asset: AxcutAsset;
	onClose: () => void;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const document = useProjectStore((s) => s.document);
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const transcriptionLabel = useTranscriptionLabel();
	const [lang, setLang] = useState<TranscriptLanguageCode>("auto");
	const regenLanguageOptions = useMemo(
		() => sortedLanguageOptions(locale, t("mediaStage.auto")),
		[locale, t],
	);
	const transcript = document?.transcripts?.find((entry) => entry.assetId === asset.id) ?? null;
	const view: AssetTranscriptionView = transcriptions[asset.id] ?? {
		assetId: asset.id,
		status: "idle",
	};
	const busy = view.status === "running" || view.status === "queued";
	const failed = view.status === "failed" && !isSilentFailure(view);

	return (
		<aside className={styles.drawer} aria-label={t("mediaStage.sourceTranscript")}>
			<div className={styles.drawerHead}>
				<h2>{t("mediaStage.sourceTranscript")}</h2>
				<button
					type="button"
					className={styles.iconButton}
					title={t("mediaStage.close")}
					aria-label={t("mediaStage.close")}
					onClick={onClose}
				>
					<X size={15} />
				</button>
			</div>
			<p className={styles.drawerName}>{asset.label || basename(asset.originalPath)}</p>
			<div className={styles.pills}>
				<span
					className={styles.statusPill}
					// A silent recording reads as a verdict about the media, not as a broken run, so
					// it keeps the neutral accent rather than the danger red engine failures get
					// (issue #628).
					data-tone={failed ? "danger" : view.status === "ready" ? "success" : "accent"}
				>
					<TranscriptionStatusDot view={view} size={5} />
					{transcriptionLabel(view)}
				</span>
				{/* The language whisper resolved on the first chunk, which every later chunk was then
				    pinned to. It belongs next to "Regenerate as": that selector is the control you
				    set BECAUSE of what was detected. */}
				{transcript?.language && transcript.language !== "auto" ? (
					<span className={styles.statusPill} data-tone="success">
						{t("mediaStage.detectedLanguage", {
							language: languageLabel(transcript.language, locale),
						})}
					</span>
				) : null}
			</div>

			{/* Renders itself away — spacing included — unless the run reports progress. */}
			<TranscriptionProgressBar view={view} />

			{view.failure ? (
				<p className={styles.hint}>
					{view.failure.kind === "error" ? view.failure.message : t("mediaStage.noAudioTrackHint")}
				</p>
			) : null}

			<div className={styles.regenerate}>
				<span>{t("mediaStage.regenerateAs")}</span>
				<div className={styles.row}>
					<select
						value={lang}
						onChange={(event) => setLang(event.target.value as TranscriptLanguageCode)}
					>
						{regenLanguageOptions.map(({ code, label }) => (
							<option key={code} value={code}>
								{label}
							</option>
						))}
					</select>
					<button
						type="button"
						className={styles.iconButton}
						title={t("mediaStage.regenerate")}
						aria-label={t("mediaStage.regenerate")}
						disabled={busy}
						onClick={() => void requestTranscription(asset.id, lang)}
					>
						<RotateCw size={14} className={busy ? "animate-spin" : undefined} />
					</button>
				</div>
			</div>

			<div className={styles.transcript}>
				{transcript ? (
					(transcript.segments ?? [])
						.map((segment) => (segment as { text?: string }).text ?? "")
						.join(" ") || t("mediaStage.transcriptEmpty")
				) : (
					<span className={styles.hint}>
						{busy
							? transcriptionLabel(view)
							: isSilentFailure(view)
								? t("mediaStage.noAudioTrackHint")
								: view.status === "failed"
									? t("mediaStage.generationFailedHint")
									: t("mediaStage.notGeneratedHint")}
					</span>
				)}
			</div>
		</aside>
	);
}
