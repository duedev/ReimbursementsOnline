import type { Category } from "../types.ts";
import { matchVendor, wordBoundaryMatcher, type VendorMatch } from "./vendors.ts";

// Category taxonomy + classification (§5 step 3). Deterministic and free.
//
// Classification is two-tiered:
//   1. Known-vendor match (vendors.ts) — a recognized brand both *names* the
//      vendor and gives its category in one pass.
//   2. Generic, non-brand keyword rules (below) — for merchants not in the brand
//      DB. Matching is **word-bounded** (adapted from the original app's
//      `_kw_pattern`) so short tokens like "inn" or "ink" can't fire inside
//      "dinner"/"drink", which the previous padded-substring approach risked.

export const CATEGORIES: Category[] = [
  "Meals & Entertainment",
  "Travel",
  "Lodging",
  "Ground Transportation",
  "Fuel",
  "Office Supplies",
  "Software & Subscriptions",
  "Utilities & Phone",
  "Shipping & Postage",
  "Professional Services",
  "Other",
];

/** Display metadata used by the board chips and the workbook theming. */
export const CATEGORY_META: Record<Category, { color: string; emoji: string }> =
  {
    "Meals & Entertainment": { color: "FFF59E0B", emoji: "🍽️" },
    Travel: { color: "FF3B82F6", emoji: "✈️" },
    Lodging: { color: "FF8B5CF6", emoji: "🏨" },
    "Ground Transportation": { color: "FF06B6D4", emoji: "🚕" },
    Fuel: { color: "FFEF4444", emoji: "⛽" },
    "Office Supplies": { color: "FF10B981", emoji: "📎" },
    "Software & Subscriptions": { color: "FF6366F1", emoji: "💻" },
    "Utilities & Phone": { color: "FF14B8A6", emoji: "📶" },
    "Shipping & Postage": { color: "FFA855F7", emoji: "📦" },
    "Professional Services": { color: "FF64748B", emoji: "🧾" },
    Other: { color: "FF94A3B8", emoji: "🗂️" },
  };

interface Rule {
  category: Category;
  /** Lowercase generic descriptors (NOT brand names — those live in vendors.ts). */
  keywords: string[];
}

// Order matters: earlier rules win on ties.
const RULES: Rule[] = [
  {
    category: "Lodging",
    keywords: ["hotel", "motel", "inn", "lodge", "resort", "hostel", "suites", "bed and breakfast"],
  },
  {
    category: "Ground Transportation",
    keywords: [
      "taxi", "cab", "rideshare", "parking", "garage", "toll", "transit",
      "subway fare", "car rental", "rental car", "light rail",
    ],
  },
  {
    category: "Fuel",
    keywords: ["gas station", "gasoline", "unleaded", "diesel", "petrol", "fuel", "per gallon", "price/gal"],
  },
  {
    category: "Travel",
    keywords: ["airline", "airlines", "airways", "airport", "boarding pass", "baggage", "flight"],
  },
  {
    category: "Meals & Entertainment",
    keywords: [
      "restaurant", "cafe", "café", "coffee", "bakery", "deli", "bistro", "diner",
      "grill", "kitchen", "tavern", "brewery", "brewing", "winery", "catering",
      "steakhouse", "sushi", "pizza", "burger", "pub",
    ],
  },
  {
    category: "Software & Subscriptions",
    keywords: ["subscription", "saas", "license", "domain", "hosting", "web services", "cloud"],
  },
  {
    category: "Utilities & Phone",
    keywords: ["electric", "water bill", "internet", "wireless", "phone bill", "utility", "broadband", "cable"],
  },
  {
    category: "Shipping & Postage",
    keywords: ["postage", "shipping", "courier", "post office", "freight", "parcel"],
  },
  {
    category: "Office Supplies",
    keywords: ["stationery", "printer", "ink", "toner", "supplies", "hardware", "lumber", "building supply"],
  },
  {
    category: "Professional Services",
    keywords: ["consulting", "legal", "attorney", "accounting", "notary", "law office", "clinic", "agency", "associates"],
  },
];

// Precompile word-boundary matchers for every keyword, once.
const RULE_PATTERNS: { category: Category; res: RegExp[] }[] = RULES.map((r) => ({
  category: r.category,
  res: r.keywords.map(wordBoundaryMatcher),
}));

/**
 * Classify a vendor/receipt text into a category. Deterministic, free.
 * @param vendor the extracted vendor name (may be empty)
 * @param hintText additional text (e.g. first OCR lines) to widen the net
 * @param known an already-computed known-vendor match; pass `null` to force the
 *   keyword path, or omit to let this function run the brand lookup itself.
 * @returns the best category and whether it was confidently matched
 */
export function categorize(
  vendor: string,
  hintText = "",
  known: VendorMatch | null = matchVendor(`${vendor} ${hintText}`),
): { category: Category; matched: boolean } {
  if (known) return { category: known.category, matched: true };
  const hay = `${vendor} ${hintText}`.toLowerCase();
  for (const rule of RULE_PATTERNS) {
    for (const re of rule.res) {
      if (re.test(hay)) return { category: rule.category, matched: true };
    }
  }
  return { category: "Other", matched: false };
}
