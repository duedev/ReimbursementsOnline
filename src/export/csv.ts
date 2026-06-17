import type { Receipt } from "../types.ts";
import { safeAmount } from "../util/money.ts";

// CSV export — adapted from the original app's `_results_to_csv`. A plain,
// importable companion to the .xlsx for expense systems that want raw rows.
// Deterministic, RFC-4180 quoting, sorted by date. Pure (no DOM), so it's
// trivially testable; the UI wraps the result in a Blob (with a UTF-8 BOM so
// Excel opens it cleanly).

const HEADERS = [
  "Category", "Date", "Vendor", "Amount", "Tax",
  "Currency", "Confidence", "Status", "Notes",
] as const;

/** Quote a field iff it contains a comma, quote or newline; double inner quotes. */
function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function statusOf(r: Receipt): string {
  if (r.status === "failed") return "Failed";
  if (r.reviewRequired && !r.approved) return "Needs review";
  if (r.approved) return "Approved";
  return "OK";
}

function notesOf(r: Receipt): string {
  return r.flags.map((f) => f.message).join("; ");
}

/** Build a CSV document (CRLF rows) from the exportable receipts. */
export function toCsv(receipts: Receipt[]): string {
  const rows = receipts
    .filter((r) => r.status !== "failed" && safeAmount(r.amount.value) > 0)
    .sort((a, b) => (a.date.value < b.date.value ? -1 : 1));

  const lines = [HEADERS.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.category.value,
        r.date.value,
        r.vendor.value,
        safeAmount(r.amount.value).toFixed(2),
        safeAmount(r.tax.value).toFixed(2),
        r.currency,
        Math.round(r.confidence * 100),
        statusOf(r),
        notesOf(r),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** "<job or employee>_<YYYY-MM-DD>.csv", sanitized. */
export function csvFileName(meta: { jobName?: string; employee?: string }): string {
  const base = (meta.jobName || meta.employee || "reimbursement")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base || "reimbursement"}_${stamp}.csv`;
}
