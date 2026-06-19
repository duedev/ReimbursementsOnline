import type { OcrEngine } from "../../ocr.ts";
import type { OcrResult, BBox } from "../../../types.ts";
import { decodeCTC } from "./ctc.ts";
import { boxesFromBitmap } from "./postprocess.ts";
import { buildOcrResult, type RecWord } from "./lines.ts";

// Tier 1 OCR engine (DESIGN §5): PaddleOCR PP-OCRv5 (separate detection +
// recognition models) running fully on-device via onnxruntime-web — same $0,
// offline, private guarantees as the default Tesseract path, but materially
// stronger on *photographed* receipts (skew, curl, low contrast, thermal fade).
//
// Opt-in via `VITE_OCR_ENGINE=paddle`. The ONNX runtime and the model weights
// are vendored same-origin under public/vendor/paddle (see
// scripts/vendor-paddle.mjs), so nothing here is bundled and the default build
// never depends on onnxruntime-web. The runtime is imported from that vendored
// URL at first use, behind /* @vite-ignore */ so Rollup leaves it alone.

function base(): string {
  return import.meta.env.BASE_URL || "/";
}

const PADDLE = {
  ortUrl: () => `${base()}vendor/paddle/ort/ort.webgpu.min.mjs`,
  wasmDir: () => `${base()}vendor/paddle/ort/`,
  detUrl: () => `${base()}vendor/paddle/models/det.onnx`,
  recUrl: () => `${base()}vendor/paddle/models/rec.onnx`,
  dictUrl: () => `${base()}vendor/paddle/models/dict.txt`,
  /** Longest edge the detector runs at (rounded to a multiple of 32). */
  detMaxSide: 960,
  /** Fixed recognizer input height; width is proportional. */
  recHeight: 48,
  recMaxWidth: 480,
  // ImageNet normalization for the detector (RGB, CHW).
  detMean: [0.485, 0.456, 0.406] as const,
  detStd: [0.229, 0.224, 0.225] as const,
};

// ---- Minimal onnxruntime-web surface (typed locally so the project compiles
//      without the package installed). ----------------------------------------
interface OrtTensor {
  data: Float32Array | Uint8Array | Int32Array | number[];
  dims: number[];
}
interface OrtSession {
  readonly inputNames: string[];
  readonly outputNames: string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
interface OrtModule {
  env: { wasm: { wasmPaths: string; numThreads: number; proxy?: boolean } };
  InferenceSession: {
    create(buffer: ArrayBuffer, options?: unknown): Promise<OrtSession>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensor;
}

interface Models {
  ort: OrtModule;
  det: OrtSession;
  rec: OrtSession;
  labels: string[];
}

export class PaddleEngine implements OcrEngine {
  private loading: Promise<Models> | null = null;

  private load(): Promise<Models> {
    if (this.loading) return this.loading;
    this.loading = (async (): Promise<Models> => {
      const ort = (await import(/* @vite-ignore */ PADDLE.ortUrl())) as unknown as OrtModule;
      ort.env.wasm.wasmPaths = PADDLE.wasmDir();
      ort.env.wasm.numThreads = 1; // avoid SharedArrayBuffer / COOP-COEP requirements

      const [detBuf, recBuf, dictText] = await Promise.all([
        fetchBuffer(PADDLE.detUrl()),
        fetchBuffer(PADDLE.recUrl()),
        fetchText(PADDLE.dictUrl()),
      ]);

      const det = await createSession(ort, detBuf);
      const rec = await createSession(ort, recBuf);
      // CTC vocab: blank at index 0, then the dictionary, then the space char.
      const labels = ["<blank>", ...dictText.replace(/\r/g, "").split("\n"), " "];
      // Drop a trailing empty line the dict file usually ends with.
      if (labels[labels.length - 2] === "") labels.splice(labels.length - 2, 1);
      return { ort, det, rec, labels };
    })().catch((err) => {
      this.loading = null; // allow a retry on the next receipt
      throw err;
    });
    return this.loading;
  }

  async recognize(image: Blob, width: number, height: number): Promise<OcrResult> {
    const models = await this.load();
    const bitmap = await createImageBitmap(image);
    try {
      // 1. Detection — run on a downscaled, /32-aligned copy.
      const { rw, rh } = detSize(width, height);
      const detData = imageToCHW(bitmap, rw, rh, PADDLE.detMean, PADDLE.detStd);
      const detOut = await runFirst(models.det, models.ort, detData, [1, 3, rh, rw]);
      const prob = toFloat32(detOut.data);
      const boxes = boxesFromBitmap(prob, rw, rh);

      // 2. Recognition — one crop per detected box, mapped back to full image.
      const scaleX = width / rw;
      const scaleY = height / rh;
      const recWords: RecWord[] = [];
      for (const box of boxes) {
        const rw0 = clampRange(Math.round(box.x0 * scaleX), 0, width - 1);
        const ry0 = clampRange(Math.round(box.y0 * scaleY), 0, height - 1);
        const rw1 = clampRange(Math.round(box.x1 * scaleX), rw0 + 1, width);
        const ry1 = clampRange(Math.round(box.y1 * scaleY), ry0 + 1, height);
        const word = await this.recognizeCrop(models, bitmap, rw0, ry0, rw1 - rw0, ry1 - ry0);
        if (!word) continue;
        recWords.push({
          text: word.text,
          confidence: word.confidence,
          bbox: normBox(rw0, ry0, rw1, ry1, width, height),
        });
      }
      return buildOcrResult(recWords);
    } finally {
      bitmap.close();
    }
  }

  private async recognizeCrop(
    models: Models,
    src: ImageBitmap,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Promise<{ text: string; confidence: number } | null> {
    if (sw <= 0 || sh <= 0) return null;
    const targetW = clampRange(
      Math.round((PADDLE.recHeight * sw) / sh),
      16,
      PADDLE.recMaxWidth,
    );
    const canvas = makeCanvas(targetW, PADDLE.recHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, targetW, PADDLE.recHeight);
    const px = ctx.getImageData(0, 0, targetW, PADDLE.recHeight).data;

    // Recognizer normalization: (v/255 - 0.5) / 0.5  →  [-1, 1], RGB, CHW.
    const plane = targetW * PADDLE.recHeight;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = ((px[i * 4] as number) / 255 - 0.5) / 0.5;
      input[plane + i] = ((px[i * 4 + 1] as number) / 255 - 0.5) / 0.5;
      input[2 * plane + i] = ((px[i * 4 + 2] as number) / 255 - 0.5) / 0.5;
    }

    const out = await runFirst(models.rec, models.ort, input, [
      1,
      3,
      PADDLE.recHeight,
      targetW,
    ]);
    // Recognizer output is [1, timeSteps, numClasses].
    const [, timeSteps = 0, numClasses = 0] = out.dims;
    const res = decodeCTC(toFloat32(out.data), timeSteps, numClasses, models.labels);
    if (!res.text.trim()) return null;
    return res;
  }

  async dispose(): Promise<void> {
    const models = await this.loading?.catch(() => null);
    await models?.det.release?.();
    await models?.rec.release?.();
    this.loading = null;
  }
}

// ---- Helpers ---------------------------------------------------------------

function detSize(width: number, height: number): { rw: number; rh: number } {
  const maxSide = Math.max(width, height);
  const ratio = maxSide > PADDLE.detMaxSide ? PADDLE.detMaxSide / maxSide : 1;
  const align = (n: number) => Math.max(32, Math.round((n * ratio) / 32) * 32);
  return { rw: align(width), rh: align(height) };
}

function imageToCHW(
  src: ImageBitmap,
  w: number,
  h: number,
  mean: readonly number[],
  std: readonly number[],
): Float32Array {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for OCR preprocessing.");
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = ((px[i * 4] as number) / 255 - mean[0]!) / std[0]!;
    out[plane + i] = ((px[i * 4 + 1] as number) / 255 - mean[1]!) / std[1]!;
    out[2 * plane + i] = ((px[i * 4 + 2] as number) / 255 - mean[2]!) / std[2]!;
  }
  return out;
}

async function runFirst(
  session: OrtSession,
  ort: OrtModule,
  data: Float32Array,
  dims: number[],
): Promise<OrtTensor> {
  const feeds: Record<string, OrtTensor> = {
    [session.inputNames[0] as string]: new ort.Tensor("float32", data, dims),
  };
  const out = await session.run(feeds);
  return out[session.outputNames[0] as string] as OrtTensor;
}

async function createSession(ort: OrtModule, buffer: ArrayBuffer): Promise<OrtSession> {
  // Prefer WebGPU when available; fall back to the WASM backend.
  try {
    return await ort.InferenceSession.create(buffer, {
      executionProviders: ["webgpu", "wasm"],
    });
  } catch {
    return ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PaddleOCR asset ${url} → HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PaddleOCR asset ${url} → HTTP ${res.status}`);
  return res.text();
}

function toFloat32(d: OrtTensor["data"]): Float32Array {
  return d instanceof Float32Array ? d : Float32Array.from(d as ArrayLike<number>);
}

function clampRange(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function normBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
): BBox {
  const c01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
  return {
    x: c01(x0 / w),
    y: c01(y0 / h),
    w: c01((x1 - x0) / w),
    h: c01((y1 - y0) / h),
  };
}
