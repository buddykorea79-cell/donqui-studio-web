// Rebuilds the app when the build is missing or older than its sources, so start-donqui.cmd
// never launches code from before the last edit or branch switch. Exit 0: ready to launch.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const INPUTS = ["src", "electron", "public", "index.html", "package.json", "vite.config.ts"];

function newestMtime(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.mtimeMs;
	let newest = 0;
	for (const entry of fs.readdirSync(target))
		newest = Math.max(newest, newestMtime(path.join(target, entry)));
	return newest;
}

function builtAt() {
	try {
		return fs.statSync(path.join(root, "dist-electron", "main.js")).mtimeMs;
	} catch {
		return 0;
	}
}

const sourcesAt = Math.max(...INPUTS.map((input) => newestMtime(path.join(root, input))));
if (builtAt() >= sourcesAt) process.exit(0);
console.log("Building Donqui Studio: the sources changed since the last build...");
const build = spawnSync("npm", ["run", "build-vite"], { cwd: root, stdio: "inherit", shell: true });
process.exit(build.status ?? 1);
