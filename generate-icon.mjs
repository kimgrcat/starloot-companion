#!/usr/bin/env node
/**
 * Generates icon.ico (multi-size Windows icon: 16/32/48/256 px) used as the
 * icon for starloot-companion.exe, from the StarLoot app's favicon
 * (source: the main StarLoot web app repo's `static/icon.png`, 622x486 —
 * the highest-resolution crop of the mark actually in use).
 *
 * This is a one-off local generation script, not part of CI — icon.ico is
 * committed to the repo root and consumed directly by the release workflow.
 * Kept here for reproducibility if the source art changes.
 *
 * Usage (run locally, needs sharp + png-to-ico, no system ImageMagick
 * required — not guaranteed present on macOS):
 *   npm install --no-save sharp png-to-ico
 *   node generate-icon.mjs <source.png> icon.ico
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const [, , srcPathArg, outPathArg] = process.argv;
const srcPath = srcPathArg ?? 'source-icon.png';
const outPath = outPathArg ?? 'icon.ico';

const SIZES = [16, 32, 48, 256];

async function main() {
	const srcBuffer = readFileSync(srcPath);

	// Pad to a square canvas first (source art is a non-square crop) so the
	// mark isn't squashed when resized to square icon sizes. Transparent
	// background matches the source's existing transparency.
	const meta = await sharp(srcBuffer).metadata();
	const side = Math.max(meta.width, meta.height);

	const squarePng = await sharp(srcBuffer)
		.resize(side, side, {
			fit: 'contain',
			background: { r: 0, g: 0, b: 0, alpha: 0 }
		})
		.png()
		.toBuffer();

	const sizedPngs = await Promise.all(
		SIZES.map((size) =>
			sharp(squarePng)
				.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
				.png()
				.toBuffer()
		)
	);

	const icoBuffer = await pngToIco(sizedPngs);
	writeFileSync(outPath, icoBuffer);
	console.log(`Wrote ${outPath} (${SIZES.join('/')} px) from ${srcPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
