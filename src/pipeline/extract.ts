import type {
  OcrResult,
  OcrLine,
  BBox,
  Category,
  Field,
  Flag,
} from "../types.ts";
import { parseAmount, detectCurrency } from "../util/money.ts";
import { monthFromName, toIso, fromIso, daysBetween } from "../util/format.ts";
import { categorize } from "../config/categories.ts";
import { CONFIDENCE, FLAGS, CURRENCY_DEFAULT } from "../config/constants.ts";

// Extract structured fields from OCR text with rules/heuristics (§5 step 3).
// Deterministic, free, portable. The goal isn't perfection — it's "right often
// enough that a quick human review fixes the rest in seconds" (§1). Every field
// carries its own confidence and the box it came from, to power the review UX.

export interface Extraction {
  vendor: Field<string>;
  date: Field<string>;
  amount: Field<number>;
  tax: Field<number>;
  currency: string;
  category: Field<Category>;
  confidence: number;
  flags: Flag[];
}

// A money token must look like money: a currency symbol, a decimal-cents part,
// or thousands grouping. Bare integers are excluded so dates/phone/quantities
// don't masquerade as amounts. The trailing lookaheads reject fragments of a
// longer number (e.g. "14.03" inside the date "14.03.2026").
const MONEY_SRC =
  "(?:[$£€¥]\\s?)?\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{2})?(?!\\d)" + // grouped
  "|(?:[$£€¥]\\s?)?\\d+[.,]\\d{2}(?![.,]?\\d)" + //                  decimal cents
  "|[$£€¥]\\s?\\d+(?![\\d.,])"; //                                  symbol + whole
const MONEY_RE = new RegExp(MONEY_SRC);
// Used only on lines we already know are labeled totals/taxes, so a whole-number
// amount ("TOTAL 9") is still picked up without risking false positives.
const LENIENT_MONEY_RE = /-?[$£€¥]?\s?\d[\d.,]*/g;

export function looksLikeMoney(s: string): boolean {
  return MONEY_RE.test(s);
}

interface MoneyHit {
  value: number;
  bbox?: BBox;
}

/** Pull money tokens from a line, with precise word boxes where possible. */
function moneyHitsFromLine(line: OcrLine, lenient = false): MoneyHit[] {
  const hits: MoneyHit[] = [];
  const scan = new RegExp(MONEY_SRC, "g");
  for (const w of line.words) {
    if (!/\d/.test(w.text)) continue;
    scan.lastIndex = 0;
    if (scan.test(w.text)) {
      const v = parseAmount(w.text);
      if (v !== null) hits.push({ value: v, bbox: w.bbox });
    }
  }
  if (hits.length === 0) {
    // Words may be split oddly (or absent); scan the whole line text.
    const matches = line.text.match(new RegExp(MONEY_SRC, "g")) ?? [];
    for (const m of matches) {
      const v = parseAmount(m);
      if (v !== null) hits.push({ value: v, bbox: line.bbox });
    }
  }
  if (hits.length === 0 && lenient) {
    const matches = line.text.match(LENIENT_MONEY_RE) ?? [];
    for (const m of matches) {
      const v = parseAmount(m);
      if (v !== null) hits.push({ value: v, bbox: line.bbox });
    }
  }
  return hits;
}

/** The right-most positive money value on a line — receipts right-align totals. */
function rightmostAmount(line: OcrLine, lenient = false): MoneyHit | null {
  const hits = moneyHitsFromLine(line, lenient).filter((h) => h.value >= 0);
  if (hits.length === 0) return null;
  return hits.reduce((best, h) =>
    (h.bbox?.x ?? 1) >= (best.bbox?.x ?? 0) ? h : best,
  );
}

const TOTAL_LABELS = [
  { re: /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due|total\s*paid)\b/i, weight: 1.0 },
  { re: /\btotal\b/i, weight: 0.85 },
];
const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;
const TAX_RE = /\b(sales\s*tax|tax|vat|gst|hst|tps|tvq)\b/i;
const DATE_LABEL_RE = /\b(date|invoice\s*date|order\s*date|transaction\s*date)\b/i;

function findAmount(lines: OcrLine[]): {
  amount: Field<number> | null;
  subtotal: number | null;
  allMax: MoneyHit | null;
} {
  let best: { hit: MoneyHit; weight: number; conf: number } | null = null;
  let subtotal: number | null = null;
  let allMax: MoneyHit | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = line.text;

    // Track the largest money value anywhere (used for reconciliation).
    for (const h of moneyHitsFromLine(line)) {
      if (!allMax || h.value > allMax.value) allMax = h;
    }

    if (SUBTOTAL_RE.test(text)) {
      const h = rightmostAmount(line);
      if (h) subtotal = h.value;
      continue; // never treat subtotal as the grand total
    }

    for (const label of TOTAL_LABELS) {
      if (label.re.test(text)) {
        // Amount may be on the same line or the next (label-only line).
        let hit = rightmostAmount(line, true);
        if (!hit && lines[i + 1]) hit = rightmostAmount(lines[i + 1]!, true);
        if (hit && hit.value > 0) {
          const conf = label.weight * (line.confidence / 100 || 0.7);
          if (!best || label.weight > best.weight) {
            best = { hit, weight: label.weight, conf };
          }
        }
        break;
      }
    }
  }

  if (best) {
    const field: Field<number> = {
      value: best.hit.value,
      confidence: Math.max(0.5, Math.min(0.97, best.conf)),
    };
    if (best.hit.bbox) field.bbox = best.hit.bbox;
    return { amount: field, subtotal, allMax };
  }

  // No labeled total — fall back to the largest money value on the receipt.
  if (allMax && allMax.value > 0) {
    const field: Field<number> = { value: allMax.value, confidence: 0.5 };
    if (allMax.bbox) field.bbox = allMax.bbox;
    return { amount: field, subtotal, allMax };
  }
  return { amount: null, subtotal, allMax };
}

function findTax(lines: OcrLine[]): Field<number> | null {
  for (const line of lines) {
    if (TAX_RE.test(line.text) && !SUBTOTAL_RE.test(line.text)) {
      const hit = rightmostAmount(line, true);
      if (hit && hit.value >= 0) {
        const field: Field<number> = {
          value: hit.value,
          confidence: 0.8 * (line.confidence / 100 || 0.7),
        };
        if (hit.bbox) field.bbox = hit.bbox;
        return field;
      }
    }
  }
  return null;
}

interface DateHit {
  iso: string;
  ambiguous: boolean;
  bbox?: BBox;
  labeled: boolean;
}

function parseDatesInLine(line: OcrLine, labeled: boolean): DateHit[] {
  const out: DateHit[] = [];
  const t = line.text;

  // ISO yyyy-mm-dd
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    pushNumeric(out, line, labeled, +m[1]!, +m[2]!, +m[3]!, "ymd");
  }
  // Numeric d/m/y or m/d/y
  for (const m of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
    pushNumeric(out, line, labeled, +m[3]!, +m[1]!, +m[2]!, "mdy");
  }
  // Month name DD, YYYY
  for (const m of t.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/g,
  )) {
    const mo = monthFromName(m[1]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[2]!, false);
  }
  // DD Month YYYY
  for (const m of t.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/g,
  )) {
    const mo = monthFromName(m[2]!);
    if (mo) addHit(out, line, labeled, +m[3]!, mo, +m[1]!, false);
  }
  return out;
}

function pushNumeric(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  year: number,
  a: number,
  b: number,
  order: "ymd" | "mdy",
): void {
  let month: number, day: number, ambiguous = false;
  if (order === "ymd") {
    month = a;
    day = b;
  } else {
    // a=first field, b=second. Default US m/d; flip if impossible; ambiguous if both <=12.
    if (a > 12 && b <= 12) {
      month = b;
      day = a;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
      ambiguous = a <= 12 && b <= 12 && a !== b;
    }
  }
  addHit(out, line, labeled, year, month, day, ambiguous);
}

function addHit(
  out: DateHit[],
  line: OcrLine,
  labeled: boolean,
  yearRaw: number,
  month: number,
  day: number,
  ambiguous: boolean,
): void {
  let year = yearRaw;
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return;
  if (year < 2000 || year > 2100) return;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return; // real date?
  const hit: DateHit = { iso: toIso(d), ambiguous, labeled };
  if (line.bbox) hit.bbox = line.bbox;
  out.push(hit);
}

function findDate(lines: OcrLine[]): Field<string> | null {
  const labeledHits: DateHit[] = [];
  const otherHits: DateHit[] = [];
  for (const line of lines) {
    const labeled = DATE_LABEL_RE.test(line.text);
    const hits = parseDatesInLine(line, labeled);
    (labeled ? labeledHits : otherHits).push(...hits);
  }
  const chosen = labeledHits[0] ?? otherHits[0];
  if (!chosen) return null;
  const field: Field<string> = {
    value: chosen.iso,
    confidence: chosen.labeled ? 0.9 : chosen.ambiguous ? 0.65 : 0.8,
  };
  if (chosen.bbox) field.bbox = chosen.bbox;
  return field;
}

const ADDRESS_RE =
  /\b(street|st\.?|ave|avenue|road|rd\.?|blvd|suite|ste|floor|fl\.?|drive|dr\.?|lane|ln\.?|way|hwy|p\.?o\.?\s*box)\b/i;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;

function looksLikeVendorLine(line: OcrLine): boolean {
  const t = line.text.trim();
  if (t.length < 3) return false;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;
  if (letters / t.length < 0.4) return false; // mostly symbols/digits
  if (MONEY_RE.test(t) && letters < 6) return false;
  if (DATE_LABEL_RE.test(t)) return false;
  if (PHONE_RE.test(t) && letters < 6) return false;
  if (ADDRESS_RE.test(t)) return false;
  if (/^(receipt|invoice|order|tel|phone|fax|www\.|http)/i.test(t)) return false;
  return true;
}

function findVendor(lines: OcrLine[]): Field<string> | null {
  const top = lines.slice(0, 6);
  // Best candidate: among the top lines, the earliest qualifying line, biased
  // toward the one with the most letters (merchant names are prominent).
  let best: { line: OcrLine; score: number } | null = null;
  top.forEach((line, i) => {
    if (!looksLikeVendorLine(line)) return;
    const letters = (line.text.match(/[A-Za-z]/g) ?? []).length;
    const positionBonus = (6 - i) * 2; // earlier is better
    const score = letters + positionBonus + (line.confidence || 50) / 25;
    if (!best || score > best.score) best = { line, score };
  });
  if (!best) return null;
  const b = best as { line: OcrLine; score: number };
  const name = cleanVendorName(b.line.text);
  if (!name) return null;
  const field: Field<string> = {
    value: name,
    confidence: Math.max(0.45, Math.min(0.9, (b.line.confidence || 60) / 100)),
  };
  if (b.line.bbox) field.bbox = b.line.bbox;
  return field;
}

function cleanVendorName(raw: string): string {
  return raw
    .replace(/[*#|_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.&'-]+$/g, "")
    .trim()
    .slice(0, 60);
}

/** Reconcile the chosen amount against the printed totals (§5). */
function reconcile(
  amount: Field<number> | null,
  tax: Field<number> | null,
  subtotal: number | null,
  allMax: MoneyHit | null,
): Flag[] {
  const flags: Flag[] = [];
  if (!amount) return flags;
  const total = amount.value;
  const tol = Math.max(FLAGS.reconcileTolerance, total * 0.005);

  // The grand total should be the largest money value on the receipt.
  if (allMax && allMax.value - total > tol) {
    flags.push({
      code: "total_mismatch",
      severity: "warn",
      message: `A larger amount (${allMax.value.toFixed(2)}) appears above the total — double-check.`,
    });
  }
  // subtotal + tax should foot to total.
  if (subtotal !== null && tax) {
    if (Math.abs(subtotal + tax.value - total) > tol) {
      flags.push({
        code: "total_mismatch",
        severity: "warn",
        message: `Subtotal ${subtotal.toFixed(2)} + tax ${tax.value.toFixed(2)} ≠ total ${total.toFixed(2)}.`,
      });
    }
  }
  return flags;
}

function dateFlags(date: Field<string> | null): Flag[] {
  const flags: Flag[] = [];
  if (!date) return flags;
  const d = fromIso(date.value);
  if (!d) return flags;
  const now = new Date();
  if (d.getTime() > now.getTime() + 86_400_000) {
    flags.push({
      code: "future_date",
      severity: "warn",
      message: "Date is in the future.",
    });
  } else if (daysBetween(d, now) > FLAGS.staleAfterDays) {
    flags.push({
      code: "stale_date",
      severity: "info",
      message: `Receipt is over ${FLAGS.staleAfterDays} days old.`,
    });
  }
  return flags;
}

/** Combine field signals + OCR quality into one overall confidence. */
function overallConfidence(
  ocr: number,
  amount: Field<number> | null,
  date: Field<string> | null,
  vendor: Field<string> | null,
  flags: Flag[],
): number {
  const ocrC = Math.min(1, Math.max(0, ocr / 100));
  const parts = [
    { w: 3, v: amount?.confidence ?? 0 },
    { w: 2, v: date?.confidence ?? 0 },
    { w: 2, v: vendor?.confidence ?? 0 },
    { w: 1, v: ocrC },
  ];
  const sumW = parts.reduce((s, p) => s + p.w, 0);
  let score = parts.reduce((s, p) => s + p.w * p.v, 0) / sumW;
  // Errors and warnings erode trust.
  for (const f of flags) {
    if (f.severity === "error") score -= 0.15;
    else if (f.severity === "warn") score -= 0.07;
  }
  return Math.max(0, Math.min(1, score));
}

export function parseReceipt(
  ocr: OcrResult,
  opts: { currencyDefault?: string } = {},
): Extraction {
  const lines = ocr.lines.length
    ? ocr.lines
    : ocr.text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map<OcrLine>((text) => ({
          text,
          confidence: ocr.confidence,
          bbox: { x: 0, y: 0, w: 1, h: 0 },
          words: [],
        }));

  const { amount, subtotal, allMax } = findAmount(lines);
  const tax = findTax(lines);
  const date = findDate(lines);
  const vendor = findVendor(lines);
  const currency = detectCurrency(ocr.text, opts.currencyDefault ?? CURRENCY_DEFAULT);

  const cat = categorize(vendor?.value ?? "", lines.slice(0, 4).map((l) => l.text).join(" "));
  const category: Field<Category> = {
    value: cat.category,
    confidence: cat.matched ? 0.85 : 0.4,
  };

  const flags: Flag[] = [];
  if (!amount) flags.push({ code: "no_amount", severity: "error", message: "No total found." });
  if (!date) flags.push({ code: "no_date", severity: "warn", message: "No date found." });
  if (!vendor) flags.push({ code: "no_vendor", severity: "warn", message: "No vendor found." });
  if (!cat.matched) flags.push({ code: "uncategorized", severity: "info", message: "Category is a guess." });
  if (amount && amount.value > FLAGS.largeAmount) {
    flags.push({
      code: "large_amount",
      severity: "info",
      message: "Unusually large amount — verify.",
    });
  }
  flags.push(...reconcile(amount, tax, subtotal, allMax));
  flags.push(...dateFlags(date));

  const confidence = overallConfidence(ocr.confidence, amount, date, vendor, flags);
  if (confidence < CONFIDENCE.reviewBelow) {
    flags.push({
      code: "low_confidence",
      severity: "info",
      message: "Low confidence — please review.",
    });
  }

  return {
    vendor: vendor ?? { value: "", confidence: 0 },
    date: date ?? { value: "", confidence: 0 },
    amount: amount ?? { value: 0, confidence: 0 },
    tax: tax ?? { value: 0, confidence: 0 },
    currency,
    category,
    confidence,
    flags,
  };
}
