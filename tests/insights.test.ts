import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInsights } from "../src/export/insights.ts";
import type { Receipt, Category } from "../src/types.ts";

function receipt(f: {
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  tax?: number;
  flagged?: boolean;
}): Receipt {
  const now = Date.now();
  return {
    id: Math.random().toString(36).slice(2),
    batchId: "b1",
    fileKey: "k",
    fileName: "r.jpg",
    mimeType: "image/jpeg",
    status: "done",
    vendor: { value: f.vendor, confidence: 0.9 },
    date: { value: f.date, confidence: 0.9 },
    amount: { value: f.amount, confidence: 0.9 },
    tax: { value: f.tax ?? 0, confidence: 0.8 },
    currency: "USD",
    category: { value: f.category, confidence: 0.9 },
    confidence: 0.9,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: !f.flagged,
    reviewRequired: Boolean(f.flagged),
    createdAt: now,
    updatedAt: now,
  };
}

const rows: Receipt[] = [
  receipt({ vendor: "Shell", amount: 45.2, category: "Fuel", date: "2026-05-01" }),
  receipt({ vendor: "Shell", amount: 50.0, category: "Fuel", date: "2026-05-03" }),
  receipt({ vendor: "The Home Depot", amount: 120.0, category: "Office Supplies", date: "2026-05-02", flagged: true }),
  receipt({ vendor: "Joe's Diner", amount: 18.5, category: "Meals & Entertainment", date: "2026-05-02", tax: 1.5 }),
];

test("headline totals, average, largest and flagged", () => {
  const s = computeInsights(rows);
  assert.equal(s.count, 4);
  assert.equal(s.total, 233.7);
  assert.equal(s.average, round2(233.7 / 4));
  assert.equal(s.largest, 120);
  assert.equal(s.flagged, 1);
  assert.equal(s.tax, 1.5);
});

test("top vendors sorted by total, merging repeats", () => {
  const s = computeInsights(rows);
  assert.equal(s.topVendors[0]!.vendor, "The Home Depot");
  assert.deepEqual(s.topVendors[1], { vendor: "Shell", count: 2, total: 95.2 });
});

test("timeline is sorted and merges same-day spend", () => {
  const s = computeInsights(rows);
  const days = s.timeline.map((t) => t.date);
  assert.deepEqual(days, [...days].sort());
  const may2 = s.timeline.find((t) => t.date === "2026-05-02")!;
  assert.equal(may2.total, 138.5); // 120 + 18.50 on the same day
  assert.equal(may2.count, 2);
});

test("expense period spans the first to last date", () => {
  const s = computeInsights(rows);
  assert.match(s.period, /May 1, 2026.*May 3, 2026/);
});

test("empty input is handled", () => {
  const s = computeInsights([]);
  assert.equal(s.count, 0);
  assert.equal(s.total, 0);
  assert.equal(s.average, 0);
  assert.deepEqual(s.timeline, []);
  assert.deepEqual(s.topVendors, []);
  assert.equal(s.period, "");
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
