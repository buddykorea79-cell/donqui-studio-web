// Launches the Electron app for the smoke scripts and hands back what they use of Playwright's
// ElectronApplication: the first window (a Playwright page, over CDP), `evaluate` in the main
// process, `process()` and `close()`.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { chromium } = require("playwright");

/**
 * Electron spawned here, its main process reached over the Node inspector and its window over
 * CDP, instead of through Playwright's `_electron.launch`. Under that launcher Electron was
 * terminated (exit code 1, no exit event, no crash report) as the first effect render began —
 * in 3 of 3 runs of vclip-smoke on 4K footage, 1 of 3 runs that only applied a saved
 * composition, and 1 of 3 runs of donqui-smoke. Spawned directly, as start-donqui.cmd spawns
 * it (plus the two debugging ports), vclip-smoke passed 3 of 3 and the apply 1 of 1. The cause
 * is not known: the launcher's two extra stdio pipes were ruled out; its injected loader and
 * Chromium switches were not.
 */
async function launchDirect({ executablePath, args, cwd, env }) {
	const child = spawn(executablePath, ["--inspect=0", "--remote-debugging-port=0", ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.resume();
	const lines = readline.createInterface({ input: child.stderr });
	const found = {};
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Electron did not start")), 60000);
		lines.on("line", (line) => {
			const node = /^Debugger listening on (ws:\/\/.*)$/.exec(line);
			const cdp = /^DevTools listening on (ws:\/\/.*)$/.exec(line);
			if (node) found.node = node[1];
			if (cdp) found.cdp = cdp[1];
			if (found.node && found.cdp) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	const inspector = new WebSocket(found.node);
	await new Promise((resolve) => inspector.addEventListener("open", resolve, { once: true }));
	let nextId = 0;
	const pending = new Map();
	inspector.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	});
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			inspector.send(JSON.stringify({ id, method, params }));
		});
	const browser = await chromium.connectOverCDP(found.cdp);
	return {
		process: () => child,
		async firstWindow() {
			for (;;) {
				const page = browser.contexts().flatMap((context) => context.pages())[0];
				if (page) return page;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		},
		/** Runs `fn(electron, arg)` in the main process, as Playwright's `app.evaluate` does. */
		async evaluate(fn, arg) {
			const reply = await send("Runtime.evaluate", {
				expression: `(${fn.toString()})(require("electron"), ${JSON.stringify(arg)})`,
				includeCommandLineAPI: true,
				awaitPromise: true,
				returnByValue: true,
			});
			if (reply.result?.exceptionDetails)
				throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 400));
			return reply.result?.result?.value;
		},
		async close() {
			inspector.close();
			await browser.close().catch(() => undefined);
			if (child.exitCode === null) child.kill();
		},
	};
}

module.exports = { launchDirect };
