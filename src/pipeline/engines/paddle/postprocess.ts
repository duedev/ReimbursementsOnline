// DB (Differentiable Binarization) post-processing for the PP-OCR detection
// head. Pure (no DOM / no ORT) so it can be unit-tested in Node.
//
// The detector outputs a per-pixel text-probability map. We binarize it, find
// connected text regions, take each region's axis-aligned bounding box, and
// expand ("unclip") it a little so the crop fed to the recognizer keeps the
// glyphs' edges. Receipt text is overwhelmingly horizontal, so axis-aligned
// boxes are a deliberate, much-simpler substitute for PaddleOCR's rotated
// min-area-rect + polygon offset — good enough for this app's hard cases
// (skew/curl/fade are handled upstream by the image clean-up pass).

export interface DetBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Mean detector probability inside the region, 0..1. */
  score: number;
}

export interface DbOptions {
  /** Pixels above this probability are "text". */
  binThreshold: number;
  /** Drop regions whose mean probability is below this. */
  boxThreshold: number;
  /** Fraction of box size to grow on every side when unclipping. */
  expand: number;
  /** Ignore regions smaller than this on either side (px in the map). */
  minSize: number;
  /** Safety cap on the number of regions returned. */
  maxBoxes: number;
}

export const DEFAULT_DB_OPTIONS: DbOptions = {
  binThreshold: 0.3,
  boxThreshold: 0.5,
  expand: 0.3,
  minSize: 3,
  maxBoxes: 1000,
};

/**
 * Extract text boxes from a probability map via connected-component analysis.
 * @param prob   flattened probability map, length === width * height
 * @param width  map width in pixels
 * @param height map height in pixels
 */
export function boxesFromBitmap(
  prob: Float32Array | number[],
  width: number,
  height: number,
  options: Partial<DbOptions> = {},
): DetBox[] {
  const opt = { ...DEFAULT_DB_OPTIONS, ...options };
  const visited = new Uint8Array(width * height);
  const boxes: DetBox[] = [];
  // Reusable BFS frontier (indices into the flat map).
  const stack: number[] = [];

  for (let start = 0; start < width * height; start++) {
    if (visited[start]) continue;
    if ((prob[start] as number) <= opt.binThreshold) {
      visited[start] = 1;
      continue;
    }

    // Flood-fill this component, tracking its bounds + probability sum.
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sum = 0;
    let count = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    while (stack.length) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;
      sum += prob[idx] as number;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4-connected neighbours.
      if (x > 0) pushIf(stack, visited, prob, idx - 1, opt.binThreshold);
      if (x < width - 1) pushIf(stack, visited, prob, idx + 1, opt.binThreshold);
      if (y > 0) pushIf(stack, visited, prob, idx - width, opt.binThreshold);
      if (y < height - 1) pushIf(stack, visited, prob, idx + width, opt.binThreshold);
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < opt.minSize || h < opt.minSize) continue;
    const score = sum / count;
    if (score < opt.boxThreshold) continue;

    // Unclip: grow the box so the recognizer crop keeps glyph edges.
    const padX = Math.round(w * opt.expand);
    const padY = Math.round(h * opt.expand);
    boxes.push({
      x0: Math.max(0, minX - padX),
      y0: Math.max(0, minY - padY),
      x1: Math.min(width - 1, maxX + padX),
      y1: Math.min(height - 1, maxY + padY),
      score,
    });
    if (boxes.length >= opt.maxBoxes) break;
  }

  return boxes;
}

function pushIf(
  stack: number[],
  visited: Uint8Array,
  prob: Float32Array | number[],
  idx: number,
  thresh: number,
): void {
  if (visited[idx]) return;
  visited[idx] = 1;
  if ((prob[idx] as number) > thresh) stack.push(idx);
}
