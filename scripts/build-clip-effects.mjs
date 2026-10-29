import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-remotion");
await bundle({
	entryPoint: path.join(root, "src/lib/clip-effects/entry.tsx"),
	outDir: path.join(output, "bundle"),
	publicDir: null,
	logLevel: "error",
});

// The app deliberately excludes node_modules from its asar. Remotion's renderer
// loads native compositor binaries by package-relative paths, so keep its small
// dependency tree intact in extraResources rather than bundling those requires.
const runtime = path.join(output, "runtime");
await mkdir(runtime, { recursive: true });
await writeFile(path.join(runtime, "package.json"), '{"private":true}\n');
// Real path: a worktree's node_modules is usually a junction to the main checkout's, and
// require.resolve answers with the target.
const nodeModules = await realpath(path.join(root, "node_modules"));
const staged = new Set();
async function stagePackage(name, fromDirectory, optional = false) {
	const resolveFrom = createRequire(path.join(fromDirectory, "package.json"));
	let manifestPath;
	try {
		manifestPath = resolveFrom.resolve(`${name}/package.json`);
	} catch {
		try {
			let directory = path.dirname(resolveFrom.resolve(name));
			while (directory !== path.dirname(directory)) {
				const candidate = path.join(directory, "package.json");
				const manifest = await readFile(candidate, "utf8")
					.then(JSON.parse)
					.catch(() => null);
				if (manifest?.name === name) {
					manifestPath = candidate;
					break;
				}
				directory = path.dirname(directory);
			}
		} catch (error) {
			if (optional) return;
			throw error;
		}
	}
	if (!manifestPath) throw new Error(`Cannot locate Remotion runtime package ${name}`);
	const directory = path.dirname(manifestPath);
	if (staged.has(directory)) return;
	staged.add(directory);
	const relative = path.relative(nodeModules, directory);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Install dependencies in this checkout before building: ${directory}`);
	const destination = path.join(runtime, "node_modules", relative);
	await cp(directory, destination, { recursive: true });
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	for (const dependency of Object.keys(manifest.dependencies ?? {}))
		await stagePackage(dependency, directory);
	for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
		await stagePackage(dependency, directory, true);
}
await stagePackage("@remotion/renderer", root);
await stagePackage("react", root);
await stagePackage("react-dom", root);
console.log(`Donqui clip effects built (${staged.size} runtime packages).`);
