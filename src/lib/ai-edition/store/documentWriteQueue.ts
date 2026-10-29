// One read-modify-save chain for the project document. A hook-local queue only
// protects edits made by that hook: an import or a transcript can still read the
// previous document while its clip insertion is being saved and write it back.
// Callers must read the document inside the task, and await the whole mutation.
let documentWriteQueue: Promise<unknown> = Promise.resolve();

export function enqueueDocumentWrite<T>(task: () => Promise<T> | T): Promise<T> {
	const queued = documentWriteQueue.then(task);
	documentWriteQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}
