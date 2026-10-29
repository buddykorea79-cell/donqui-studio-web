// Generate native application icons from the editable Donqui SVG.
// Requires sharp; DONQUI_SHARP_MODULE can point to an existing installation.
// Run: node scripts/generate-donqui-icons.cjs && npm run assets:appx
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require(process.env.DONQUI_SHARP_MODULE || "sharp");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "icons", "donqui");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function ico(images) {
	const header = Buffer.alloc(6 + images.length * 16);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, i) => {
		const entry = 6 + i * 16;
		header[entry] = header[entry + 1] = size === 256 ? 0 : size;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function icns(pngs) {
	const chunks = [
		["ic07", 128],
		["ic08", 256],
		["ic09", 512],
		["ic10", 1024],
	].map(([type, size]) => {
		const png = pngs.get(size);
		const header = Buffer.alloc(8);
		header.write(type, 0, 4, "ascii");
		header.writeUInt32BE(png.length + 8, 4);
		return Buffer.concat([header, png]);
	});
	const header = Buffer.alloc(8);
	header.write("icns", 0, 4, "ascii");
	header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
	return Buffer.concat([header, ...chunks]);
}

async function main() {
	for (const dir of ["png", "win", "mac"]) {
		await fs.mkdir(path.join(OUT, dir), { recursive: true });
	}
	const source = await fs.readFile(path.join(ROOT, "public", "donqui.svg"));
	await fs.writeFile(path.join(ROOT, "src", "assets", "donqui-mark.svg"), source);
	const pngs = new Map();
	for (const size of SIZES) {
		const png = await sharp(source, { density: 600 })
			.resize(size, size)
			.ensureAlpha()
			.png({ palette: false })
			.toBuffer();
		pngs.set(size, png);
		await fs.writeFile(path.join(OUT, "png", `${size}x${size}.png`), png);
	}
	await fs.writeFile(path.join(ROOT, "public", "donqui.png"), pngs.get(256));
	await fs.writeFile(
		path.join(OUT, "win", "icon.ico"),
		ico(SIZES.filter((size) => size <= 256).map((size) => ({ size, data: pngs.get(size) }))),
	);
	await fs.writeFile(path.join(OUT, "mac", "icon.icns"), icns(pngs));
	console.log("Donqui PNG, ICO, and ICNS icons generated from public/donqui.svg");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
