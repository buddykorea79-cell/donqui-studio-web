import { validateProjectData } from "@/components/video-editor/projectPersistence";
import { migrateAxcutDocumentToProjectData } from "@/lib/ai-edition/document/migrate";
import { documentSchema } from "@/lib/ai-edition/schema";
/** Keep the current document intact: down-migrating it loses all secondary clips. */
export function resolveExportProject(raw: unknown) {
	const current = documentSchema.safeParse(raw);
	if (current.success)
		return { project: migrateAxcutDocumentToProjectData(current.data), document: current.data };
	if (!validateProjectData(raw)) throw new Error("Project file is not a valid .openscreen project");
	return { project: raw, document: null };
}
