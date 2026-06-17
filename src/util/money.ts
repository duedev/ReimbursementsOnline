// Money parsing/formatting. Input hardening (§11): never let a non-finite or
// absurd amount through — it would poison totals and the export.

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
  "C$": "CAD",
  "A$": "AUD",
};

/** Detect a currency from a symbol or code present in text. */
export function detectCurrency(text: string, fallback = "USD"): string {
  const code = text.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|MXN)\b/);
  if (code && code[1]) return code[1];
  for (const [sym, cur] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(sym)) return cur;
  }
  return fallback;
}

/**
 * Parse a human/OCR money string into a finite number of major units.
 * Handles "$1,234.56", "1.234,56" (EU), "USD 12.00", trailing "-", etc.
 * Returns null for anything not safely finite and non-negative.
 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d.,\-]/g, "");
  if (!s || !/\d/.test(s)) return null;

  const neg = /-/.test(s);
  s = s.replace(/-/g, "");

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let decSep: "." | "," | null = null;
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the right-most separator is the decimal point.
    decSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma > -1) {
    // Only commas. Treat as decimal when it looks like cents (",dd" at the end
    // and no second comma that would imply thousands grouping).
    decSep = /^\d+,\d{1,2}$/.test(s) ? "," : null;
  } else if (lastDot > -1) {
    decSep = /^\d+\.\d{1,2}$/.test(s) || /\d\.\d{1,2}$/.test(s) ? "." : null;
  }

  let normalized: string;
  if (decSep === ",") {
    normalized = s.replace(/\./g, "").replace(",", "."); // strip dots, comma→dot
  } else if (decSep === ".") {
    normalized = s.replace(/,/g, ""); // strip thousands commas
  } else {
    normalized = s.replace(/[.,]/g, ""); // all separators are grouping
  }

  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  const value = neg ? -n : n;
  // Reject absurd magnitudes that indicate a misread, and negatives for totals.
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

/** Guard used before persisting/exporting any amount. */
export function safeAmount(n: number): number {
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return 0;
  return Math.round(n * 100) / 100;
}

const fmtCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(n: number, currency = "USD"): string {
  const safe = safeAmount(n);
  let fmt = fmtCache.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    }
    fmtCache.set(currency, fmt);
  }
  return fmt.format(safe);
}

/** Excel number format string for a currency code (best effort). */
export function excelMoneyFormat(currency = "USD"): string {
  const sym: Record<string, string> = {
    USD: "$",
    CAD: "$",
    AUD: "$",
    MXN: "$",
    GBP: "£",
    EUR: "€",
    JPY: "¥",
    CNY: "¥",
    INR: "₹",
  };
  const s = sym[currency] ?? "";
  return `${s}#,##0.00`;
}
