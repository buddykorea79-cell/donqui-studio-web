import { validateWorkspace, type WebWorkspace } from "./project";

const DATABASE = "donqui-studio-web";
const STORE = "workspaces";
const CURRENT = "current";

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("이 브라우저는 프로젝트 저장소를 지원하지 않습니다."));
			return;
		}
		const request = indexedDB.open(DATABASE, 1);
		let failed = false;
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE);
		};
		request.onblocked = () => {
			failed = true;
			reject(new Error("다른 Donqui Studio 탭을 닫은 후 다시 시도해 주세요."));
		};
		request.onerror = () => reject(request.error ?? new Error("프로젝트 저장소를 열 수 없습니다."));
		request.onsuccess = () => {
			const database = request.result;
			if (failed) {
				database.close();
				return;
			}
			database.onversionchange = () => database.close();
			resolve(database);
		};
	});
}

async function transaction<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const database = await openDatabase();
	try {
		return await new Promise<T>((resolve, reject) => {
			const current = database.transaction(STORE, mode);
			const request = run(current.objectStore(STORE));
			current.oncomplete = () => resolve(request.result);
			current.onabort = () =>
				reject(current.error ?? request.error ?? new Error("프로젝트 저장이 중단되었습니다."));
			current.onerror = () =>
				reject(
					current.error ?? request.error ?? new Error("프로젝트 저장소에 접근할 수 없습니다."),
				);
		});
	} finally {
		database.close();
	}
}

export async function loadWorkspace(): Promise<WebWorkspace | null> {
	const value: unknown = await transaction("readonly", (store) => store.get(CURRENT));
	return value === undefined ? null : validateWorkspace(value);
}

/** One transaction commits media blobs and timeline together, including on quota failure. */
export async function saveWorkspace(workspace: WebWorkspace): Promise<void> {
	const valid = validateWorkspace(workspace);
	await transaction("readwrite", (store) => store.put(valid, CURRENT));
}

export async function clearWorkspace(): Promise<void> {
	await transaction("readwrite", (store) => store.delete(CURRENT));
}
