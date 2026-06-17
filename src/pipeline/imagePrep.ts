import { IMAGE_PREP } from "../config/constants.ts";
import { isPdf } from "../util/files.ts";

// Image pre-pass (§5 step 1, §14). Runs entirely client-side on a <canvas>:
//   decode → auto-rotate (EXIF) → grayscale → auto-crop background → downscale.
// Free, improves every downstream step, shrinks uploads, and lowers the cost of
// any optional paid call. Output is a sharp JPEG that OCR and export both reuse.

export interface CleanedImage {
  blob: Blob;
  width: number;
  height: number;
  /** Object URL for display; caller is responsible for revoking. */
  url: string;
}

/** Decode any supported input (image or first PDF page) into a bitmap. */
async function decode(file: File | Blob): Promise<ImageBitmap> {
  if (file instanceof File && isPdf(file)) {
    return decodePdfFirstPage(file);
  }
  try {
    // imageOrientation:'from-image' applies EXIF rotation automatically.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

async function decodePdfFirstPage(file: File): Promise<ImageBitmap> {
  // Lazy-load pdf.js so the (large) renderer is only pulled in for PDFs.
  const pdfjs = await import("pdfjs-dist");
  // Vite resolves this worker URL at build time.
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ).default;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  const bmp = await createImageBitmap(canvas);
  doc.destroy();
  return bmp;
}

/** Compute a content bounding box by trimming low-energy (blank) margins. */
function detectContentBox(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // luminance
    gray[p] =
      0.299 * (data[i] ?? 0) +
      0.587 * (data[i + 1] ?? 0) +
      0.114 * (data[i + 2] ?? 0);
  }
  const rowEnergy = new Float32Array(h);
  const colEnergy = new Float32Array(w);
  let maxEnergy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const gx = Math.abs((gray[idx + 1] ?? 0) - (gray[idx - 1] ?? 0));
      const gy = Math.abs((gray[idx + w] ?? 0) - (gray[idx - w] ?? 0));
      const e = gx + gy;
      rowEnergy[y] = (rowEnergy[y] ?? 0) + e;
      colEnergy[x] = (colEnergy[x] ?? 0) + e;
    }
  }
  for (let y = 0; y < h; y++) maxEnergy = Math.max(maxEnergy, rowEnergy[y] ?? 0);
  let maxCol = 0;
  for (let x = 0; x < w; x++) maxCol = Math.max(maxCol, colEnergy[x] ?? 0);

  const rowThresh = maxEnergy * 0.06;
  const colThresh = maxCol * 0.06;

  let top = 0,
    bottom = h - 1,
    left = 0,
    right = w - 1;
  while (top < h && (rowEnergy[top] ?? 0) < rowThresh) top++;
  while (bottom > top && (rowEnergy[bottom] ?? 0) < rowThresh) bottom--;
  while (left < w && (colEnergy[left] ?? 0) < colThresh) left++;
  while (right > left && (colEnergy[right] ?? 0) < colThresh) right--;

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

export async function cleanImage(file: File | Blob): Promise<CleanedImage> {
  const bmp = await decode(file);
  const srcW = bmp.width;
  const srcH = bmp.height;

  // --- auto-crop analysis on a small copy (cheap) ---
  let crop = { x: 0, y: 0, w: srcW, h: srcH };
  if (IMAGE_PREP.autoCrop && srcW > 200 && srcH > 200) {
    const aMax = 480;
    const aScale = Math.min(1, aMax / Math.max(srcW, srcH));
    const aw = Math.max(1, Math.round(srcW * aScale));
    const ah = Math.max(1, Math.round(srcH * aScale));
    const ac = document.createElement("canvas");
    ac.width = aw;
    ac.height = ah;
    const actx = ac.getContext("2d", { willReadFrequently: true })!;
    actx.drawImage(bmp, 0, 0, aw, ah);
    const box = detectContentBox(actx.getImageData(0, 0, aw, ah).data, aw, ah);
    const area = (box.w * box.h) / (aw * ah);
    // Only accept a crop that keeps a sensible region (guards over-cropping).
    if (area > 0.45 && box.w > aw * 0.4 && box.h > ah * 0.4) {
      const pad = 0.02;
      const px = box.w * pad;
      const py = box.h * pad;
      crop = {
        x: Math.max(0, (box.x - px) / aScale),
        y: Math.max(0, (box.y - py) / aScale),
        w: Math.min(srcW, (box.w + 2 * px) / aScale),
        h: Math.min(srcH, (box.h + 2 * py) / aScale),
      };
    }
  }

  // --- downscale the (cropped) region to the target max edge ---
  const scale = Math.min(1, IMAGE_PREP.maxEdge / Math.max(crop.w, crop.h));
  const outW = Math.max(1, Math.round(crop.w * scale));
  const outH = Math.max(1, Math.round(crop.h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  if (IMAGE_PREP.grayscale && "filter" in ctx) {
    ctx.filter = "grayscale(1) contrast(1.08)";
  }
  ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  bmp.close();

  const blob = await canvasToBlob(canvas, "image/jpeg", IMAGE_PREP.quality);
  return { blob, width: outW, height: outH, url: URL.createObjectURL(blob) };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))),
      type,
      quality,
    );
  });
}
