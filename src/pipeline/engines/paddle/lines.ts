// Assemble recognized word boxes into the OcrResult shape the rest of the
// pipeline already consumes (text + lines + words, with 0..1 normalized boxes
// and 0..100 confidences). Pure (no DOM / no ORT), so it is unit-testable.

import type { OcrResult, OcrLine, OcrWord, BBox } from "../../../types.ts";

/** A single recognized box: text + 0..1 confidence + normalized bbox. */
export interface RecWord {
  text: string;
  confidence: number; // 0..1
  bbox: BBox; // normalized to the image it ran on (0..1)
}

/**
 * Group recognized boxes into reading-order lines. Boxes are sorted top→bottom,
 * then a box joins the current line when its vertical centre sits within the
 * line's band (receipts are row-structured), and within a line boxes sort
 * left→right.
 */
export function buildOcrResult(words: RecWord[]): OcrResult {
  const clean = words
    .filter((w) => w.text.trim().length > 0 && w.bbox.h > 0)
    .sort((a, b) => centerY(a.bbox) - centerY(b.bbox));

  const lines: OcrLine[] = [];
  const allWords: OcrWord[] = [];
  let current: RecWord[] = [];
  let bandTop = 0;
  let bandBottom = 0;

  const flush = () => {
    if (!current.length) return;
    current.sort((a, b) => a.bbox.x - b.bbox.x);
    lines.push(makeLine(current));
    current = [];
  };

  for (const w of clean) {
    const cy = centerY(w.bbox);
    if (!current.length) {
      current.push(w);
      bandTop = w.bbox.y;
      bandBottom = w.bbox.y + w.bbox.h;
    } else if (cy >= bandTop && cy <= bandBottom) {
      current.push(w);
      bandTop = Math.min(bandTop, w.bbox.y);
      bandBottom = Math.max(bandBottom, w.bbox.y + w.bbox.h);
    } else {
      flush();
      current.push(w);
      bandTop = w.bbox.y;
      bandBottom = w.bbox.y + w.bbox.h;
    }
  }
  flush();

  for (const line of lines) allWords.push(...line.words);

  const overall = lines.length
    ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length
    : 0;

  return {
    text: lines.map((l) => l.text).join("\n"),
    confidence: overall, // already 0..100 (line confidences are)
    lines,
    words: allWords,
  };
}

function makeLine(words: RecWord[]): OcrLine {
  const ocrWords: OcrWord[] = words.map((w) => ({
    text: w.text,
    confidence: w.confidence * 100,
    bbox: w.bbox,
  }));
  const x0 = Math.min(...words.map((w) => w.bbox.x));
  const y0 = Math.min(...words.map((w) => w.bbox.y));
  const x1 = Math.max(...words.map((w) => w.bbox.x + w.bbox.w));
  const y1 = Math.max(...words.map((w) => w.bbox.y + w.bbox.h));
  const conf =
    (words.reduce((s, w) => s + w.confidence, 0) / words.length) * 100;
  return {
    text: ocrWords.map((w) => w.text).join(" ").trim(),
    confidence: conf,
    bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    words: ocrWords,
  };
}

function centerY(b: BBox): number {
  return b.y + b.h / 2;
}
