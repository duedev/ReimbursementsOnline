// Vendors the Tier 1 OCR engine (DESIGN §5) — PaddleOCR PP-OCRv5 on
// onnxruntime-web — into public/vendor/paddle so it is served same-origin,
// works offline, and is cached by the service worker after first use. Mirrors
// scripts/vendor-tesseract.mjs.
//
// This is OPT-IN and NOT wired into predev/prebuild: the default app ships the
// $0 Tesseract path. To enable PaddleOCR:
//
//   npm install onnxruntime-web
//   npm run vendor:paddle
//   VITE_OCR_ENGINE=paddle npm run build   # (or `npm run dev`)
//
// Two pieces are vendored:
//   1. The onnxruntime-web runtime (ESM bundle + wasm), copied from node_modules.
//   2. PP-OCRv5 detection + recognition ONNX models and the character dict,
//      downloaded once. Model URLs are best-effort defaults — override with
//      PADDLE_DET_URL / PADDLE_REC_URL / PADDLE_DICT_URL, or drop the three
//      files into public/vendor/paddle/models yourself (det.onnx, rec.onnx,
//      dict.txt). Mobile PP-OCRv5 models are only a few MB each.
//
// Everything is non-fatal: a missing runtime or an unreachable model prints
// instructions and exits 0 so it never blocks the default build.

import { mkdir, copyFile, access, writeFile, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ortOut = join(root, "public", "vendor", "paddle", "ort");
const modelOut = join(root, "public", "vendor", "paddle", "models");
await mkdir(ortOut, { recursive: true });
await mkdir(modelOut, { recursive: true });

// --- 1. onnxruntime-web runtime -----------------------------------------
const ortDist = join(root, "node_modules", "onnxruntime-web", "dist");
let haveOrt = false;
try {
  await access(ortDist);
  haveOrt = true;
} catch {
  console.warn(
    "! onnxruntime-web is not installed — skipping runtime copy.\n" +
      "  Run `npm install onnxruntime-web` first, then re-run this script.",
  );
}

if (haveOrt) {
  const all = await readdir(ortDist);
  // The WebGPU ESM bundle the engine imports, plus every wasm binary it loads.
  const wanted = all.filter(
    (f) =>
      f === "ort.webgpu.min.mjs" ||
      f === "ort.min.mjs" ||
      f.endsWith(".wasm"),
  );
  if (!wanted.includes("ort.webgpu.min.mjs")) {
    console.warn(
      "! ort.webgpu.min.mjs not found in this onnxruntime-web build; the engine\n" +
        "  imports that bundle. Check your onnxruntime-web version (>=1.17).",
    );
  }
  for (const name of wanted) {
    await copyFile(join(ortDist, name), join(ortOut, name));
  }
  console.log(`vendored ${wanted.length} onnxruntime-web files → public/vendor/paddle/ort`);
}

// --- 2. PP-OCRv5 models + dictionary ------------------------------------
const SOURCES = {
  "det.onnx":
    process.env.PADDLE_DET_URL ||
    "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/PP-OCRv5_mobile_det.onnx",
  "rec.onnx":
    process.env.PADDLE_REC_URL ||
    "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/PP-OCRv5_mobile_rec.onnx",
  "dict.txt":
    process.env.PADDLE_DICT_URL ||
    "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/ppocrv5_dict.txt",
};

let downloaded = 0;
let failed = 0;
for (const [name, url] of Object.entries(SOURCES)) {
  const dest = join(modelOut, name);
  try {
    const s = await stat(dest);
    if (s.size > 1000) {
      console.log(`  · ${name} already present (${(s.size / 1e6).toFixed(2)} MB)`);
      continue;
    }
  } catch {
    /* not present yet */
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error("suspiciously small");
    await writeFile(dest, buf);
    console.log(`  · vendored ${name} (${(buf.length / 1e6).toFixed(2)} MB)`);
    downloaded++;
  } catch (err) {
    failed++;
    console.warn(`  · ${name}: ${err.message} — ${url}`);
  }
}

if (failed > 0) {
  console.warn(
    `! ${failed} model file(s) could not be downloaded automatically.\n` +
      "  Provide them with PADDLE_DET_URL / PADDLE_REC_URL / PADDLE_DICT_URL,\n" +
      "  or place det.onnx, rec.onnx and dict.txt in public/vendor/paddle/models\n" +
      "  yourself (any PP-OCRv5 mobile ONNX export works).",
  );
} else if (downloaded > 0) {
  console.log("PaddleOCR models vendored → public/vendor/paddle/models");
}
