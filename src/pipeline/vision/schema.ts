import type { Category, Field, Flag } from "../../types.ts";
import type { Extraction } from "../extract.ts";
import { CATEGORIES, categorize } from "../../config/categories.ts";
import { CONFIDENCE, FLAGS, CURRENCY_DEFAULT } from "../../config/constants.ts";
import { parseAmount, safeAmount } from "../../util/money.ts";
import { isValidIso, fromIso, daysBetween } from "../../util/format.ts";

// The contract with the vision model + the mapping of its JSON back into the
// app's `Extraction` shape. Pure (no network, no DOM) so it is unit-testable
// and shared by every provider.

/** JSON Schema for structured outputs (OpenAI / OpenRouter / Anthropic dialect). */
export const RECEIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vendor: { type: "string", description: "Merchant/brand name, not the street address." },
    date: { type: "string", description: "Purchase date as ISO yyyy-mm-dd." },
    amount: { type: "number", description: "Grand total actually paid." },
    tax: { type: "number", description: "Tax amount, or 0 if none shown." },
    currency: { type: "string", description: "ISO 4217 code, e.g. USD." },
    category: { type: "string", enum: CATEGORIES },
  },
  required: ["vendor", "date", "amount", "tax", "currency", "category"],
} as const;

/** Gemini uses an OpenAPI-style schema dialect (uppercase type names). */
export function geminiSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      vendor: { type: "STRING" },
      date: { type: "STRING" },
      amount: { type: "NUMBER" },
      tax: { type: "NUMBER" },
      currency: { type: "STRING" },
      category: { type: "STRING", enum: [...CATEGORIES] },
    },
    required: ["vendor", "date", "amount", "tax", "currency", "category"],
  };
}

export const SYSTEM_PROMPT =
  "You are a meticulous receipt-data extractor. Read the receipt image and " +
  "return ONLY the requested fields as strict JSON. Use the merchant/brand name " +
  "for vendor (never the street address). Date must be ISO yyyy-mm-dd. amount is " +
  "the grand total actually paid; tax is the tax line (0 if none). Pick the single " +
  "best category from the allowed list. Do not invent values you cannot see.";

export function userInstruction(currencyDefault: string): string {
  return (
    "Extract the receipt fields as JSON. Allowed categories: " +
    CATEGORIES.join(", ") +
    `. If no currency is visible, use ${currencyDefault}.`
  );
}

/** Best-effort JSON parse of a model text response (tolerates code fences and
 *  surrounding prose). Returns a loose record or null. */
export function parseVisionJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const KNOWN_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "INR", "CNY", "MXN",
]);

function coerceAmount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return safeAmount(v);
  if (typeof v === "string") return safeAmount(parseAmount(v) ?? 0);
  return 0;
}

/** Map a model's loose JSON into the app's `Extraction` (same shape the rules
 *  path produces), so the rest of the pipeline is identical for either tier. */
export function visionToExtraction(
  raw: Record<string, unknown>,
  currencyDefault = CURRENCY_DEFAULT,
): Extraction {
  const vendorName = String(raw.vendor ?? "").trim().slice(0, 80);
  const amountVal = coerceAmount(raw.amount);
  const taxVal = coerceAmount(raw.tax);

  const dateRaw = String(raw.date ?? "").trim();
  const dateVal = isValidIso(dateRaw) ? dateRaw : "";

  const curRaw = String(raw.currency ?? "").trim().toUpperCase();
  const currency = KNOWN_CURRENCIES.has(curRaw) ? curRaw : currencyDefault;

  const catRaw = String(raw.category ?? "").trim();
  const modelCat = CATEGORIES.find((c) => c === catRaw);
  const cat: { category: Category; matched: boolean } = modelCat
    ? { category: modelCat, matched: true }
    : categorize(vendorName);

  const vendor: Field<string> = { value: vendorName, confidence: vendorName ? 0.9 : 0 };
  const date: Field<string> = { value: dateVal, confidence: dateVal ? 0.9 : 0 };
  const amount: Field<number> = { value: amountVal, confidence: amountVal > 0 ? 0.92 : 0 };
  const tax: Field<number> = { value: taxVal, confidence: 0.85 };
  const category: Field<Category> = {
    value: cat.category,
    confidence: cat.matched ? 0.9 : 0.4,
  };

  const flags: Flag[] = [];
  if (amountVal <= 0) flags.push({ code: "no_amount", severity: "error", message: "No total found." });
  if (!dateVal) flags.push({ code: "no_date", severity: "warn", message: "No date found." });
  if (!vendorName) flags.push({ code: "no_vendor", severity: "warn", message: "No vendor found." });
  if (!cat.matched) flags.push({ code: "uncategorized", severity: "info", message: "Category is a guess." });
  if (amountVal > FLAGS.largeAmount) {
    flags.push({ code: "large_amount", severity: "info", message: "Unusually large amount — verify." });
  }
  flags.push(...dateFlags(dateVal));

  // A vision read with all key fields present is high-confidence; missing fields
  // and warnings pull it down, routing the receipt back into the review sweep.
  let confidence = 0.92;
  if (amountVal <= 0) confidence -= 0.45;
  if (!dateVal) confidence -= 0.15;
  if (!vendorName) confidence -= 0.15;
  for (const f of flags) {
    if (f.severity === "error") confidence -= 0.15;
    else if (f.severity === "warn") confidence -= 0.07;
  }
  confidence = Math.max(0, Math.min(1, confidence));
  if (confidence < CONFIDENCE.reviewBelow) {
    flags.push({ code: "low_confidence", severity: "info", message: "Low confidence — please review." });
  }

  return { vendor, date, amount, tax, currency, category, confidence, flags };
}

function dateFlags(iso: string): Flag[] {
  const flags: Flag[] = [];
  const d = fromIso(iso);
  if (!d) return flags;
  const now = new Date();
  if (d.getTime() > now.getTime() + 86_400_000) {
    flags.push({ code: "future_date", severity: "warn", message: "Date is in the future." });
  } else if (daysBetween(d, now) > FLAGS.staleAfterDays) {
    flags.push({
      code: "stale_date",
      severity: "info",
      message: `Receipt is over ${FLAGS.staleAfterDays} days old.`,
    });
  }
  return flags;
}
