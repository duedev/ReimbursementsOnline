import { test } from "node:test";
import assert from "node:assert/strict";
import { matchVendor, wordBoundaryMatcher } from "../src/config/vendors.ts";
import { categorize } from "../src/config/categories.ts";
import { parseReceipt } from "../src/pipeline/extract.ts";
import type { OcrResult, OcrLine } from "../src/types.ts";

function ocr(lines: string[], confidence = 88): OcrResult {
  const ocrLines: OcrLine[] = lines.map((text, i) => ({
    text,
    confidence,
    bbox: { x: 0, y: i / lines.length, w: 1, h: 1 / lines.length },
    words: [],
  }));
  return { text: lines.join("\n"), confidence, lines: ocrLines, words: [] };
}

// ── matchVendor: known brand → canonical name + category ───────────────────────

test("matches a known brand and its category", () => {
  const shell = matchVendor("SHELL\n123 Main St\nTOTAL $45.20");
  assert.equal(shell?.name, "Shell");
  assert.equal(shell?.category, "Fuel");

  const hd = matchVendor("THE HOME DEPOT #1234");
  assert.equal(hd?.name, "The Home Depot");
  assert.equal(hd?.category, "Office Supplies");

  const wm = matchVendor("WALMART SUPERCENTER");
  assert.equal(wm?.name, "Walmart");
});

test("longest alias wins over a generic word it contains", () => {
  // "home depot" must beat a bare "depot"-like hit.
  assert.equal(matchVendor("WELCOME TO HOME DEPOT")?.name, "The Home Depot");
  // "amazon web services" must beat "amazon".
  const aws = matchVendor("AMAZON WEB SERVICES INVOICE");
  assert.equal(aws?.name, "Amazon Web Services");
  assert.equal(aws?.category, "Software & Subscriptions");
  // plain Amazon still resolves to the retail mapping.
  assert.equal(matchVendor("AMAZON.COM ORDER")?.name, "Amazon");
  // "uber eats" must beat "uber".
  assert.equal(matchVendor("UBER EATS ORDER")?.category, "Meals & Entertainment");
  assert.equal(matchVendor("UBER TRIP")?.category, "Ground Transportation");
});

test("returns null when no known vendor is present", () => {
  assert.equal(matchVendor("JOE'S CORNER CAFE\nTOTAL $9.00"), null);
  assert.equal(matchVendor(""), null);
});

test("matching is word-bounded (no substring false positives)", () => {
  // "bp" must not match inside "subprime".
  assert.equal(matchVendor("SUBPRIME LENDING LLC"), null);
  // a price ending in .76 must not read as a fuel brand.
  assert.equal(matchVendor("ITEM TOTAL $45.76"), null);
  // "ups" inside "groups" / "startups" must not match The UPS Store / UPS.
  assert.equal(matchVendor("FOCUS GROUPS LLC"), null);
});

test("wordBoundaryMatcher: numeric guard rejects digit-adjacent hits", () => {
  const re = wordBoundaryMatcher("76");
  assert.equal(re.test("union 76 station"), true);
  assert.equal(re.test("$45.76"), false);
  assert.equal(re.test("store #76"), false);
  assert.equal(re.test("760 main"), false);
});

// ── categorize: brand precedence + word-bounded keyword fallback ───────────────

test("categorize prefers a known brand, else word-bounded keywords", () => {
  assert.deepEqual(categorize("Shell"), { category: "Fuel", matched: true });
  // generic keyword path for an unknown merchant.
  assert.deepEqual(categorize("Joe's Bistro", "fine dining"), {
    category: "Meals & Entertainment",
    matched: true,
  });
  // "inn" must not fire inside "dinner" (word-bounded keyword).
  assert.deepEqual(categorize("Dinner Club", ""), { category: "Other", matched: false });
  // but a standalone "Inn" is Lodging.
  assert.deepEqual(categorize("Seaside Inn", ""), { category: "Lodging", matched: true });
});

// ── integration through parseReceipt: brand named over the address ─────────────

test("offline parser prefers the known vendor over the store address", () => {
  const r = parseReceipt(
    ocr(["123 Main Street", "SHELL", "UNLEADED", "TOTAL $45.20", "05/01/2026"]),
  );
  assert.equal(r.vendor.value, "Shell"); // not "123 Main Street"
  assert.equal(r.category.value, "Fuel");
  assert.equal(r.amount.value, 45.2);
});

test("falls back to the business name when the vendor is unknown", () => {
  const r = parseReceipt(
    ocr(["456 Commerce Blvd", "ACME WIDGETS LLC", "TOTAL $30.00"]),
  );
  assert.match(r.vendor.value, /ACME WIDGETS/i); // address line skipped
  assert.equal(r.amount.value, 30);
});
