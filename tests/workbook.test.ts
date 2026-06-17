import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildWorkbook } from "../src/export/workbook.ts";
import type { Batch, Receipt, Category } from "../src/types.ts";

function receipt(f: {
  vendor: string;
  amount: number;
  category: Category;
  date: string;
  tax?: number;
  status?: Receipt["status"];
}): Receipt {
  const now = Date.now();
  return {
    id: Math.random().toString(36).slice(2),
    batchId: "b1",
    fileKey: "k",
    fileName: "r.jpg",
    mimeType: "image/jpeg",
    status: f.status ?? "done",
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
    approved: true,
    reviewRequired: false,
    createdAt: now,
    updatedAt: now,
  };
}

const batch: Batch = {
  id: "b1",
  employee: "Ada Lovelace",
  jobName: "Q1 Travel",
  jobNumber: "JOB-42",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const receipts: Receipt[] = [
  receipt({ vendor: "Delta", amount: 320.5, category: "Travel", date: "2026-01-04" }),
  receipt({ vendor: "Marriott", amount: 210.0, category: "Lodging", date: "2026-01-05" }),
  receipt({ vendor: "Blue Bottle", amount: 8.99, category: "Meals & Entertainment", date: "2026-01-05" }),
  receipt({ vendor: "Uber", amount: 23.4, category: "Ground Transportation", date: "2026-01-06" }),
];

test("buildWorkbook produces a valid multi-sheet workbook with footing totals", async () => {
  const result = await buildWorkbook(batch, receipts, async () => undefined);
  assert.equal(result.count, 4);
  assert.equal(result.totalCost, 0);
  assert.match(result.fileName, /Q1_Travel_\d{4}-\d{2}-\d{2}\.xlsx/);

  // Re-open the produced bytes and assert structure.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await result.blob.arrayBuffer());
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes("Summary"));
  assert.ok(names.includes("Insights"));
  assert.ok(names.includes("All Receipts"));
  assert.ok(names.includes("Travel"));
  assert.ok(names.includes("Lodging"));

  // Insights sheet surfaces the headline total.
  const insightsWs = wb.getWorksheet("Insights")!;
  const sumAmounts = receipts.reduce((s, r) => s + r.amount.value, 0);
  let foundInsightsTotal = false;
  insightsWs.eachRow((row) => {
    if (String(row.getCell(2).value ?? "") === "Total") {
      assert.ok(Math.abs(Number(row.getCell(3).value) - sumAmounts) < 0.001);
      foundInsightsTotal = true;
    }
  });
  assert.ok(foundInsightsTotal, "insights has a total KPI");

  // Summary grand total formula footing should equal the sum of amounts.
  const expectedTotal = receipts.reduce((s, r) => s + r.amount.value, 0);
  const summary = wb.getWorksheet("Summary")!;
  let foundTotal = false;
  summary.eachRow((row) => {
    const label = String(row.getCell(2).value ?? "");
    if (label === "Grand total") {
      const cell = row.getCell(4).value as { result?: number } | number;
      const val = typeof cell === "object" ? cell.result : cell;
      assert.ok(
        Math.abs(Number(val) - expectedTotal) < 0.001,
        `grand total ${String(val)} ≈ ${expectedTotal}`,
      );
      foundTotal = true;
    }
  });
  assert.ok(foundTotal, "summary has a grand total row");
});

test("buildWorkbook skips failed and zero-amount receipts", async () => {
  const withBad = [
    ...receipts,
    receipt({ vendor: "Broken", amount: 0, category: "Other", date: "2026-01-07", status: "failed" }),
  ];
  const result = await buildWorkbook(batch, withBad, async () => undefined);
  assert.equal(result.count, 4); // the zero/failed one is excluded
});
