import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// This configuration deliberately has no Electron plugin or native build hooks.
// Keep the desktop entry intact while serving the browser app at the same root URL.
export default defineConfig({
	cacheDir: path.resolve(__dirname, ".vite-web-cache"),
	publicDir: "public-web",
	plugins: [
		{
			name: "donqui-web-entry",
			transformIndexHtml: {
				order: "pre",
				handler: (html) =>
					html
						.replace('src="/src/main.tsx"', 'src="/src/web/main.tsx"')
						.replace('<html lang="en">', '<html lang="ko">')
						.replace("<title>Donqui Studio</title>", "<title>Donqui Studio Web</title>"),
			},
		},
		react(),
	],
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
		dedupe: ["react", "react-dom", "react/jsx-runtime"],
	},
	server: {
		port: 5173,
		watch: {
			ignored: ["**/crates/**", "**/.claude/**", "**/electron/native/**", "**/dist*/**"],
		},
	},
	build: {
		outDir: "dist-web",
		target: "es2022",
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("mediabunny")) return "video-processing";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
				},
			},
		},
	},
});
