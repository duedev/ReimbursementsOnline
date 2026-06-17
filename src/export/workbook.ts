import ExcelJS from "exceljs";
import type { Batch, Receipt, Category } from "../types.ts";
import { CATEGORIES, CATEGORY_META } from "../config/categories.ts";
import { excelMoneyFormat, safeAmount } from "../util/money.ts";
import { formatDate } from "../util/format.ts";
import { thumbnail } from "./images.ts";

// The output is the point (§3). A themed, multi-sheet workbook: a Summary the
// user can submit, per-category sheets with the receipt images attached, totals
// that *foot* (real SUM formulas), conditional formatting, and an honest
// "extraction cost" line. This is what makes the whole app worth using.

const TEAL = "FF0F766E";
const TEAL_DARK = "FF0B5048";
const INK = "FF0B1120";
const STRIPE = "FFF1F5F9";
const AMBER = "FFFEF3C7";
const SLATE = "FF475569";

export interface ExportResult {
  blob: Blob;
  fileName: string;
  totalCost: number;
  count: number;
}

/** Embedded image handle keyed by receipt id. */
type ImageMap = Map<string, { id: number; w: number; h: number }>;

function exportable(receipts: Receipt[]): Receipt[] {
  return receipts
    .filter((r) => r.status !== "failed" && safeAmount(r.amount.value) > 0)
    .sort((a, b) => (a.date.value < b.date.value ? -1 : 1));
}

export async function buildWorkbook(
  batch: Batch,
  receipts: Receipt[],
  getBlob: (key: string) => Promise<Blob | undefined>,
): Promise<ExportResult> {
  const rows = exportable(receipts);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Reimbursements Online";
  wb.created = new Date();
  wb.properties.date1904 = false;

  // Pre-embed thumbnails once; reuse the image ids across sheets.
  const imageByReceipt: ImageMap = new Map();
  for (const r of rows) {
    const key = r.cleanedKey ?? r.fileKey;
    const blob = await getBlob(key);
    if (!blob) continue;
    try {
      const t = await thumbnail(blob);
      const id = wb.addImage({ buffer: t.buffer, extension: t.ext });
      // Fit within a 150×120 px box, preserving aspect.
      const scale = Math.min(150 / t.width, 120 / t.height, 1);
      imageByReceipt.set(r.id, {
        id,
        w: Math.round(t.width * scale),
        h: Math.round(t.height * scale),
      });
    } catch {
      /* skip image on failure — the row still exports */
    }
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const currency = dominantCurrency(rows);

  buildSummarySheet(wb, batch, rows, totalCost, currency);
  buildReceiptsSheet(wb, "All Receipts", rows, imageByReceipt, true);

  for (const cat of CATEGORIES) {
    const inCat = rows.filter((r) => r.category.value === cat);
    if (inCat.length === 0) continue;
    buildReceiptsSheet(wb, sheetName(cat), inCat, imageByReceipt, false, cat);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return {
    blob,
    fileName: makeFileName(batch),
    totalCost,
    count: rows.length,
  };
}

// ---- Summary sheet --------------------------------------------------------

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  batch: Batch,
  rows: Receipt[],
  totalCost: number,
  currency: string,
): void {
  const ws = wb.addWorksheet("Summary", {
    properties: { tabColor: { argb: TEAL } },
    views: [{ showGridLines: false }],
  });
  ws.getColumn(1).width = 3;
  ws.getColumn(2).width = 26;
  ws.getColumn(3).width = 14;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;

  // Title band
  ws.mergeCells("B2:E2");
  const title = ws.getCell("B2");
  title.value = "Expense Reimbursement";
  title.font = { size: 20, bold: true, color: { argb: "FFFFFFFF" } };
  title.alignment = { vertical: "middle" };
  ws.mergeCells("B3:E3");
  const sub = ws.getCell("B3");
  sub.value = batch.jobName || "Reimbursement Report";
  sub.font = { size: 11, color: { argb: "FFD1FAE5" } };
  for (const ref of ["B2", "C2", "D2", "E2", "B3", "C3", "D3", "E3"]) {
    ws.getCell(ref).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: TEAL },
    };
  }
  ws.getRow(2).height = 30;
  ws.getRow(3).height = 18;

  // Meta block
  const meta: [string, string][] = [
    ["Employee", batch.employee || "—"],
    ["Job name", batch.jobName || "—"],
    ["Job number", batch.jobNumber || "—"],
    ["Generated", formatDate(toLocalIso(new Date()))],
    ["Receipts", String(rows.length)],
    [
      "Flagged for review",
      String(rows.filter((r) => r.reviewRequired && !r.approved).length),
    ],
  ];
  let r = 5;
  for (const [k, v] of meta) {
    ws.getCell(`B${r}`).value = k;
    ws.getCell(`B${r}`).font = { color: { argb: SLATE }, size: 10 };
    ws.mergeCells(`C${r}:E${r}`);
    ws.getCell(`C${r}`).value = v;
    ws.getCell(`C${r}`).font = { bold: true, color: { argb: INK } };
    r++;
  }

  // Category breakdown
  r += 1;
  const headRow = r;
  const headers = ["Category", "Count", "Amount", "Tax"];
  headers.forEach((h, i) => {
    const cell = ws.getCell(headRow, 2 + i);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
    cell.alignment = { horizontal: i === 0 ? "left" : "right" };
  });
  ws.getRow(headRow).height = 18;
  r++;

  const fmt = excelMoneyFormat(currency);
  const firstDataRow = r;
  for (const cat of CATEGORIES) {
    const inCat = rows.filter((x) => x.category.value === cat);
    if (inCat.length === 0) continue;
    const amount = inCat.reduce((s, x) => s + safeAmount(x.amount.value), 0);
    const tax = inCat.reduce((s, x) => s + safeAmount(x.tax.value), 0);
    const meta2 = CATEGORY_META[cat];
    ws.getCell(r, 2).value = `${meta2.emoji} ${cat}`;
    ws.getCell(r, 3).value = inCat.length;
    ws.getCell(r, 3).alignment = { horizontal: "right" };
    ws.getCell(r, 4).value = amount;
    ws.getCell(r, 4).numFmt = fmt;
    ws.getCell(r, 5).value = tax;
    ws.getCell(r, 5).numFmt = fmt;
    // category color swatch on the left border
    ws.getCell(r, 2).border = {
      left: { style: "thick", color: { argb: meta2.color } },
    };
    r++;
  }
  const lastDataRow = r - 1;

  // Grand total row (real formulas → totals foot)
  const totalRow = r;
  ws.getCell(totalRow, 2).value = "Grand total";
  ws.getCell(totalRow, 2).font = { bold: true, size: 12 };
  if (lastDataRow >= firstDataRow) {
    ws.getCell(totalRow, 3).value = {
      formula: `SUM(C${firstDataRow}:C${lastDataRow})`,
      result: rows.length,
    };
    ws.getCell(totalRow, 4).value = {
      formula: `SUM(D${firstDataRow}:D${lastDataRow})`,
      result: rows.reduce((s, x) => s + safeAmount(x.amount.value), 0),
    };
    ws.getCell(totalRow, 5).value = {
      formula: `SUM(E${firstDataRow}:E${lastDataRow})`,
      result: rows.reduce((s, x) => s + safeAmount(x.tax.value), 0),
    };
  }
  for (let c = 2; c <= 5; c++) {
    const cell = ws.getCell(totalRow, c);
    cell.font = { bold: true, size: 12, color: { argb: INK } };
    cell.border = { top: { style: "double", color: { argb: TEAL_DARK } } };
    if (c >= 4) cell.numFmt = fmt;
    if (c === 3) cell.alignment = { horizontal: "right" };
  }
  ws.getRow(totalRow).height = 20;

  // Honest cost line
  r = totalRow + 2;
  ws.getCell(`B${r}`).value = "Extraction cost";
  ws.getCell(`B${r}`).font = { color: { argb: SLATE }, size: 10 };
  ws.getCell(`C${r}`).value = totalCost;
  ws.getCell(`C${r}`).numFmt = '"$"#,##0.00';
  ws.getCell(`C${r}`).font = {
    bold: true,
    color: { argb: totalCost === 0 ? "FF15803D" : INK },
  };
  ws.getCell(`D${r}`).value =
    totalCost === 0 ? "Processed free, on your device." : "";
  ws.getCell(`D${r}`).font = { italic: true, color: { argb: SLATE }, size: 10 };
  ws.mergeCells(`D${r}:E${r}`);
}

// ---- Receipts sheet (All + per-category) ---------------------------------

function buildReceiptsSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: Receipt[],
  images: ImageMap,
  withCategory: boolean,
  category?: Category,
): void {
  const tabColor = category ? CATEGORY_META[category].color : TEAL;
  const ws = wb.addWorksheet(name, {
    properties: { tabColor: { argb: tabColor } },
    views: [{ showGridLines: false, state: "frozen", ySplit: 4 }],
  });

  const cols = withCategory
    ? ["#", "Date", "Vendor", "Category", "Amount", "Tax", "Conf.", "Notes", "Receipt"]
    : ["#", "Date", "Vendor", "Amount", "Tax", "Conf.", "Notes", "Receipt"];
  const widths = withCategory
    ? [4, 13, 26, 22, 14, 12, 8, 30, 24]
    : [4, 13, 30, 14, 12, 8, 34, 24];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // Title band
  ws.mergeCells(1, 1, 1, cols.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = category ? `${CATEGORY_META[category].emoji} ${category}` : "All Receipts";
  titleCell.font = { size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle" };
  for (let c = 1; c <= cols.length; c++) {
    ws.getCell(1, c).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: tabColor },
    };
  }
  ws.getRow(1).height = 26;
  ws.addRow([]);

  // Header row (row 3)
  const headerRowIndex = 3;
  const header = ws.getRow(headerRowIndex);
  cols.forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: alignFor(h) };
  });
  header.height = 18;

  const amountCol = withCategory ? 5 : 4;
  const taxCol = amountCol + 1;
  const confCol = taxCol + 1;
  const imageCol = cols.length;

  const dataStart = headerRowIndex + 1;
  let rIdx = dataStart;
  rows.forEach((rec, i) => {
    const values: (string | number)[] = withCategory
      ? [
          i + 1,
          formatDate(rec.date.value),
          rec.vendor.value || "—",
          `${CATEGORY_META[rec.category.value].emoji} ${rec.category.value}`,
          safeAmount(rec.amount.value),
          safeAmount(rec.tax.value),
          Math.round(rec.confidence * 100),
          notesFor(rec),
        ]
      : [
          i + 1,
          formatDate(rec.date.value),
          rec.vendor.value || "—",
          safeAmount(rec.amount.value),
          safeAmount(rec.tax.value),
          Math.round(rec.confidence * 100),
          notesFor(rec),
        ];
    const line = ws.getRow(rIdx);
    values.forEach((v, c) => (line.getCell(c + 1).value = v));

    const fmt = excelMoneyFormat(rec.currency);
    line.getCell(amountCol).numFmt = fmt;
    line.getCell(taxCol).numFmt = fmt;
    line.getCell(confCol).alignment = { horizontal: "center" };
    line.getCell(2).alignment = { horizontal: "left" };
    line.getCell(cols.length - 1).alignment = { wrapText: true, vertical: "top" };

    // zebra stripe
    if (i % 2 === 1) {
      for (let c = 1; c <= cols.length; c++) {
        line.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: STRIPE },
        };
      }
    }
    // highlight rows still needing review
    if (rec.reviewRequired && !rec.approved) {
      for (let c = 1; c <= cols.length; c++) {
        line.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: AMBER },
        };
      }
    }

    // embed the receipt image
    const img = images.get(rec.id);
    if (img) {
      const h = Math.max(img.h, 60);
      line.height = h * 0.78; // px → points-ish
      ws.addImage(img.id, {
        tl: { col: imageCol - 1 + 0.1, row: rIdx - 1 + 0.1 },
        ext: { width: img.w, height: img.h },
        editAs: "oneCell",
      });
    } else {
      line.height = 18;
    }
    rIdx++;
  });
  const dataEnd = rIdx - 1;

  // Totals row with footing formulas
  if (dataEnd >= dataStart) {
    const totalRow = ws.getRow(rIdx);
    totalRow.getCell(amountCol - 1).value = "Total";
    totalRow.getCell(amountCol - 1).font = { bold: true };
    const colLetter = (n: number) => ws.getColumn(n).letter;
    totalRow.getCell(amountCol).value = {
      formula: `SUM(${colLetter(amountCol)}${dataStart}:${colLetter(amountCol)}${dataEnd})`,
      result: rows.reduce((s, x) => s + safeAmount(x.amount.value), 0),
    };
    totalRow.getCell(taxCol).value = {
      formula: `SUM(${colLetter(taxCol)}${dataStart}:${colLetter(taxCol)}${dataEnd})`,
      result: rows.reduce((s, x) => s + safeAmount(x.tax.value), 0),
    };
    for (const c of [amountCol, taxCol]) {
      const cell = totalRow.getCell(c);
      cell.numFmt = excelMoneyFormat(rows[0]?.currency ?? "USD");
      cell.font = { bold: true, color: { argb: INK } };
      cell.border = { top: { style: "double", color: { argb: TEAL_DARK } } };
    }
    totalRow.getCell(amountCol - 1).border = {
      top: { style: "double", color: { argb: TEAL_DARK } },
    };
    totalRow.height = 18;

    // Conditional formatting: confidence data bar + large-amount highlight.
    const confLetter = colLetter(confCol);
    ws.addConditionalFormatting({
      ref: `${confLetter}${dataStart}:${confLetter}${dataEnd}`,
      rules: [
        {
          type: "dataBar",
          cfvo: [
            { type: "num", value: 0 },
            { type: "num", value: 100 },
          ],
          color: { argb: TEAL },
          priority: 1,
        } as ExcelJS.ConditionalFormattingRule,
      ],
    });
    const amtLetter = colLetter(amountCol);
    ws.addConditionalFormatting({
      ref: `${amtLetter}${dataStart}:${amtLetter}${dataEnd}`,
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: ["1000"],
          priority: 2,
          style: {
            font: { color: { argb: "FFB91C1C" }, bold: true },
          },
        } as ExcelJS.ConditionalFormattingRule,
      ],
    });
  }

  // Autofilter over the header.
  ws.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: Math.max(dataStart, dataEnd), column: cols.length },
  };
}

// ---- helpers --------------------------------------------------------------

function alignFor(h: string): "left" | "right" | "center" {
  if (h === "Amount" || h === "Tax") return "right";
  if (h === "Conf." || h === "#") return "center";
  return "left";
}

function notesFor(r: Receipt): string {
  if (r.flags.length === 0) return r.approved ? "Approved" : "";
  return r.flags
    .filter((f) => f.code !== "low_confidence" || !r.approved)
    .map((f) => f.message)
    .join(" ");
}

function dominantCurrency(rows: Receipt[]): string {
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best = "USD";
  let max = 0;
  for (const [cur, n] of counts) if (n > max) ((max = n), (best = cur));
  return best;
}

function sheetName(cat: Category): string {
  // Excel sheet names: max 31 chars, no []:*?/\
  return cat.replace(/[[\]:*?/\\]/g, "").slice(0, 31);
}

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeFileName(batch: Batch): string {
  const safe = (batch.jobName || batch.employee || "reimbursement")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  const stamp = toLocalIso(new Date());
  return `${safe || "reimbursement"}_${stamp}.xlsx`;
}
