import { Check, RefreshCw } from "lucide-react";
import { useEffect, useId } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	effectiveModel,
	useVisionModelStore,
	type VisionModelStatus,
	visionModelStatus,
} from "@/lib/vclip/visionModels";
import styles from "./NewEditorShell.module.css";

/**
 * The local Ollama vision model V.Clip scores and describes footage with. It sits with the
 * other AI options, though unlike the chat providers it needs no key: it runs on this machine,
 * and V.Clip only ever talks to it over loopback.
 */
export function OllamaVisionSettings() {
	const te = useScopedT("editor");
	const selectId = useId();
	const models = useVisionModelStore((state) => state.models);
	const loading = useVisionModelStore((state) => state.loading);
	const chosen = useVisionModelStore((state) => state.chosen);
	const status = visionModelStatus(models, loading, chosen);
	const selected = effectiveModel(chosen, models);

	useEffect(() => {
		if (!useVisionModelStore.getState().models) void useVisionModelStore.getState().load();
	}, []);

	return (
		<section className={styles.ollamaSection} aria-label={te("providerSettings.ollama.title")}>
			<div className={styles.ollamaHead}>
				<h4>{te("providerSettings.ollama.title")}</h4>
				{status.kind === "ready" || status.kind === "off" ? (
					<span className={`${styles.statusPill} ${styles.ready}`}>
						<Check size={10} />
						{te("providerSettings.pillConnected")}
					</span>
				) : (
					<span className={`${styles.statusPill} ${styles.idle}`}>
						{te("providerSettings.notConnected")}
					</span>
				)}
			</div>
			<p>{te("providerSettings.ollama.description")}</p>
			<div className={styles.ollamaRow}>
				<label htmlFor={selectId}>{te("providerSettings.ollama.modelLabel")}</label>
				<select
					id={selectId}
					value={selected ?? ""}
					disabled={loading || !models}
					onChange={(event) => useVisionModelStore.getState().choose(event.target.value || null)}
				>
					{models?.models.map((model) => (
						<option key={model.name} value={model.name}>
							{model.name}
							{model.parameterSize ? ` · ${model.parameterSize}` : ""}
						</option>
					))}
					<option value="">{te("providerSettings.ollama.withoutAi")}</option>
				</select>
				<button
					type="button"
					title={te("providerSettings.ollama.refresh")}
					aria-label={te("providerSettings.ollama.refresh")}
					disabled={loading}
					onClick={() => void useVisionModelStore.getState().load()}
				>
					<RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
				</button>
			</div>
			<p role="status">{statusText(status, te)}</p>
		</section>
	);
}

function statusText(
	status: VisionModelStatus,
	te: (key: string, vars?: Record<string, string | number>) => string,
): string {
	switch (status.kind) {
		case "checking":
			return te("providerSettings.ollama.checking");
		case "unavailable":
			return te("providerSettings.ollama.unavailable", {
				url: status.baseUrl || "Ollama",
			});
		case "no-models":
			return te("providerSettings.ollama.noModels", { url: status.baseUrl });
		case "off":
			return te("providerSettings.ollama.off", { count: status.count });
		case "ready":
			return te("providerSettings.ollama.ready", { url: status.baseUrl, count: status.count });
	}
}
