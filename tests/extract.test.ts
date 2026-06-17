import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/pipeline/extract.ts";
import type { OcrResult, OcrLine } from "../src/types.ts";

// Build a synthetic OCR result from text lines (words left empty; the extractor
// falls back to per-line text scanning, which is what we exercise here).
function ocr(lines: string[], confidence = 88): OcrResult {
  const ocrLines: OcrLine[] = lines.map((text, i) => ({
    text,
    confidence,
    bbox: { x: 0, y: i / lines.length, w: 1, h: 1 / lines.length },
    words: [],
  }));
  return { text: lines.join("\n"), confidence, lines: ocrLines, words: [] };
}

test("restaurant receipt → vendor, date, total, tax, category", () => {
  const r = parseReceipt(
    ocr([
      "BLUE BOTTLE COFFEE",
      "123 Main St, San Francisco CA",
      "Date: 03/14/2026",
      "Latte           4.50",
      "Croissant        3.75",
      "Subtotal         8.25",
      "Sales Tax        0.74",
      "TOTAL            8.99",
    ]),
  );
  assert.equal(r.amount.value, 8.99);
  assert.equal(r.tax.value, 0.74);
  assert.equal(r.date.value, "2026-03-14");
  assert.match(r.vendor.value, /BLUE BOTTLE/i);
  assert.equal(r.category.value, "Meals & Entertainment");
  assert.ok(r.confidence > 0.6, `confidence ${r.confidence}`);
});

test("prefers grand total over subtotal and reconciles", () => {
  const r = parseReceipt(
    ocr([
      "Office Depot",
      "Subtotal     100.00",
      "Tax            8.00",
      "GRAND TOTAL  108.00",
    ]),
  );
  assert.equal(r.amount.value, 108);
  assert.equal(r.category.value, "Office Supplies");
  // 100 + 8 == 108 → no total_mismatch flag
  assert.ok(!r.flags.some((f) => f.code === "total_mismatch"));
});

test("flags a footing mismatch", () => {
  const r = parseReceipt(
    ocr(["Shop", "Subtotal 100.00", "Tax 8.00", "TOTAL 120.00"]),
  );
  assert.equal(r.amount.value, 120);
  assert.ok(r.flags.some((f) => f.code === "total_mismatch"));
});

test("missing total → no_amount error + needs review", () => {
  const r = parseReceipt(ocr(["Some Vendor", "Thanks for visiting"]));
  assert.equal(r.amount.value, 0);
  assert.ok(r.flags.some((f) => f.code === "no_amount" && f.severity === "error"));
});

test("European date and amount", () => {
  const r = parseReceipt(
    ocr(["Café Berlin", "Datum 14.03.2026", "Summe  19,90 EUR"]),
  );
  assert.equal(r.currency, "EUR");
  assert.equal(r.amount.value, 19.9);
  assert.equal(r.date.value, "2026-03-14");
});

test("future date is flagged", () => {
  const r = parseReceipt(ocr(["Vendor", "Date 01/01/2099", "Total 5.00"]));
  assert.ok(r.flags.some((f) => f.code === "future_date"));
});

test("rideshare categorized as ground transportation", () => {
  const r = parseReceipt(
    ocr(["Uber", "Trip fare", "Total $23.40", "01/05/2026"]),
  );
  assert.equal(r.category.value, "Ground Transportation");
  assert.equal(r.amount.value, 23.4);
});

test("unlabeled receipt falls back to largest amount", () => {
  const r = parseReceipt(ocr(["Corner Store", "Item A 2.00", "Item B 19.95"]));
  assert.equal(r.amount.value, 19.95);
  // low confidence because there was no labeled total
  assert.ok(r.amount.confidence <= 0.6);
});
