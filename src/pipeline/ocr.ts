import { createWorker, type Worker } from "tesseract.js";
import { OCR } from "../config/constants.ts";
import type { OcrResult, OcrLine, OcrWord, BBox } from "../types.ts";

// "Reading text" is a *capability*, not a model (§5). Everything upstream and
// downstream is identical whether this is open-source OCR, a paid OCR API, or a
// vision model — so it sits behind one tiny interface. The default, free,
// runs-on-device implementation is Tesseract.js (its own web worker keeps the
// main thread free), with assets served same-origin for offline use.

export interface OcrEngine {
  /** Recognize text + word boxes from a cleaned image. */
  recognize(image: Blob, width: number, height: number): Promise<OcrResult>;
  /** Release resources (terminate workers). */
  dispose(): Promise<void>;
}

function base(): string {
  // Resolves correctly whether served from a domain root or a project subpath.
  return import.meta.env.BASE_URL || "/";
}

interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RawWord {
  text: string;
  confidence: number;
  bbox: RawBox;
}

interface RawLine {
  text: string;
  confidence: number;
  bbox: RawBox;
  words?: RawWord[];
}

interface RawBlock {
  paragraphs?: { lines?: RawLine[] }[];
}

class TesseractEngine implements OcrEngine {
  private worker: Worker | null = null;
  private initPromise: Promise<Worker> | null = null;

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.initPromise) {
      const langPath = OCR.useLocal
        ? `${base()}${OCR.localLangPath}`
        : OCR.cdnLangPath;
      this.initPromise = createWorker(OCR.language, 1, {
        workerPath: `${base()}vendor/tesseract/worker.min.js`,
        corePath: `${base()}vendor/tesseract/`,
        langPath,
      }).then((w) => {
        this.worker = w;
        return w;
      });
    }
    return this.initPromise;
  }

  async recognize(image: Blob, width: number, height: number): Promise<OcrResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(
      image,
      {},
      { text: true, blocks: true },
    );

    const norm = (b: RawBox): BBox => ({
      x: clamp01(b.x0 / width),
      y: clamp01(b.y0 / height),
      w: clamp01((b.x1 - b.x0) / width),
      h: clamp01((b.y1 - b.y0) / height),
    });

    const words: OcrWord[] = [];
    const lines: OcrLine[] = [];

    // tesseract.js v5 nests results in blocks → paragraphs → lines → words.
    const blocks = (data as unknown as { blocks?: RawBlock[] }).blocks ?? [];
    for (const block of blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const lineWords: OcrWord[] = (line.words ?? []).map((w) => ({
            text: w.text,
            confidence: w.confidence,
            bbox: norm(w.bbox),
          }));
          words.push(...lineWords);
          lines.push({
            text: line.text.trim(),
            confidence: line.confidence,
            bbox: norm(line.bbox),
            words: lineWords,
          });
        }
      }
    }

    return {
      text: data.text ?? "",
      confidence: data.confidence ?? 0,
      lines,
      words,
    };
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.initPromise = null;
    }
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

let singleton: OcrEngine | null = null;

/** The default engine. Swap this factory to change the extraction tier (§5). */
export function getOcrEngine(): OcrEngine {
  if (!singleton) singleton = new TesseractEngine();
  return singleton;
}
