import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCTC } from "../src/pipeline/engines/paddle/ctc.ts";
import { boxesFromBitmap } from "../src/pipeline/engines/paddle/postprocess.ts";
import { buildOcrResult, type RecWord } from "../src/pipeline/engines/paddle/lines.ts";

// Tier 1 (PaddleOCR) pure post-processing. The ONNX inference itself needs the
// model weights + a browser; these exercise the deterministic logic around it.

test("CTC greedy decode collapses repeats and drops blanks", () => {
  const labels = ["<blank>", "a", "b"];
  // rows (argmax): a, a(repeat→collapse), blank, a  ⇒ "aa"
  const probs = [
    0.1, 0.8, 0.1,
    0.2, 0.7, 0.1,
    0.9, 0.05, 0.05,
    0.1, 0.85, 0.05,
  ];
  const out = decodeCTC(probs, 4, 3, labels);
  assert.equal(out.text, "aa");
  // confidence = mean of the two emitted steps' max-probs (0.8, 0.85)
  assert.ok(Math.abs(out.confidence - 0.825) < 1e-9);
});

test("CTC decode keeps distinct adjacent chars and a blank-separated repeat", () => {
  const labels = ["<blank>", "a", "b"];
  // a, b, blank, b ⇒ "abb"
  const probs = [
    0.1, 0.8, 0.1,
    0.1, 0.1, 0.8,
    0.9, 0.05, 0.05,
    0.1, 0.2, 0.7,
  ];
  assert.equal(decodeCTC(probs, 4, 3, labels).text, "abb");
});

test("DB post-processing finds one unclipped box for a solid region", () => {
  const W = 10;
  const H = 6;
  const prob = new Float32Array(W * H);
  // A solid text block at x∈[2,5], y∈[1,3].
  for (let y = 1; y <= 3; y++) {
    for (let x = 2; x <= 5; x++) prob[y * W + x] = 1;
  }
  const boxes = boxesFromBitmap(prob, W, H, { expand: 0.3 });
  assert.equal(boxes.length, 1);
  const b = boxes[0]!;
  // Unclipped box must fully contain the original region.
  assert.ok(b.x0 <= 2 && b.x1 >= 5 && b.y0 <= 1 && b.y1 >= 3);
  assert.ok(Math.abs(b.score - 1) < 1e-6);
});

test("DB post-processing drops a faint region below the box threshold", () => {
  const W = 8;
  const H = 4;
  const prob = new Float32Array(W * H);
  for (let y = 1; y <= 2; y++) {
    for (let x = 2; x <= 4; x++) prob[y * W + x] = 0.35; // above bin, below box
  }
  const boxes = boxesFromBitmap(prob, W, H, { binThreshold: 0.3, boxThreshold: 0.5 });
  assert.equal(boxes.length, 0);
});

test("line grouping sorts top→bottom then left→right", () => {
  const words: RecWord[] = [
    { text: "TOTAL", confidence: 0.9, bbox: { x: 0.05, y: 0.5, w: 0.2, h: 0.06 } },
    { text: "9.99", confidence: 0.8, bbox: { x: 0.7, y: 0.51, w: 0.15, h: 0.06 } },
    { text: "CAFE", confidence: 0.95, bbox: { x: 0.1, y: 0.05, w: 0.3, h: 0.07 } },
  ];
  const res = buildOcrResult(words);
  assert.equal(res.lines.length, 2);
  assert.equal(res.lines[0]!.text, "CAFE");
  assert.equal(res.lines[1]!.text, "TOTAL 9.99");
  assert.ok(res.confidence > 0);
});
