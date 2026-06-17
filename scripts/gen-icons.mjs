// One-off icon generator: rasterizes the source SVG into the PNG sizes the
// web app manifest and Apple devices need. Run with `node scripts/gen-icons.mjs`.
// `sharp` is a dev-only dependency used solely here; the shipped app needs none.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "public", "icons");
const svg = await readFile(join(iconsDir, "favicon.svg"));

const bg = "#0b1120";

const targets = [
  { name: "icon-192.png", size: 192, pad: 0 },
  { name: "icon-512.png", size: 512, pad: 0 },
  // Maskable needs ~10% safe padding so the glyph survives a circular mask.
  { name: "icon-maskable-512.png", size: 512, pad: 0.12 },
  { name: "apple-touch-icon.png", size: 180, pad: 0 },
];

for (const { name, size, pad } of targets) {
  const inner = Math.round(size * (1 - pad * 2));
  const offset = Math.round((size - inner) / 2);
  const glyph = await sharp(svg).resize(inner, inner).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: bg },
  })
    .composite([{ input: glyph, top: offset, left: offset }])
    .png()
    .toFile(join(iconsDir, name));
  console.log(`wrote ${name} (${size}x${size})`);
}
