import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { type DocumentWriteOptions, useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";

/**
 * Read-modify-save on the shared document queue: `change` runs on the document as the previous
 * write left it, and nothing is written when a project switch or an undo came first. Resolves
 * true once saved; false when there was nothing to change or the write did not land.
 */
export function mutateDocument(
	change: (document: AxcutDocument) => AxcutDocument,
	options: DocumentWriteOptions,
): Promise<boolean> {
	const projectId = useProjectStore.getState().projectId;
	const epoch = currentWriteEpoch();
	return enqueueDocumentWrite(async () => {
		const state = useProjectStore.getState();
		if (
			!state.document ||
			!projectId ||
			state.projectId !== projectId ||
			currentWriteEpoch() !== epoch
		)
			return false;
		const next = change(state.document);
		if (next === state.document) return false;
		return state.saveDocument(next, options);
	});
}
