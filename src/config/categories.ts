import type { Category } from "../types.ts";

// Curated vendor → category lookup (§5 step 3). Deterministic and free.
// Matching is substring/keyword based against the OCR'd vendor + top lines.
// This is intentionally a plain table so it is trivial to extend per-deployment
// without touching code paths.

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
  /** Lowercase keywords; any hit assigns the category. Ordered by specificity. */
  keywords: string[];
}

// Order matters: earlier rules win on ties. Specific brands before generics.
const RULES: Rule[] = [
  {
    category: "Lodging",
    keywords: [
      "marriott",
      "hilton",
      "hyatt",
      "sheraton",
      "westin",
      "holiday inn",
      "hampton inn",
      "courtyard",
      "ramada",
      "motel",
      "hotel",
      "inn ",
      "airbnb",
      "lodge",
      "resort",
      "hostel",
    ],
  },
  {
    category: "Ground Transportation",
    keywords: [
      "uber",
      "lyft",
      "taxi",
      "cab",
      "metro",
      "transit",
      "parking",
      "park ",
      "garage",
      "toll",
      "hertz",
      "avis",
      "enterprise rent",
      "budget rent",
      "zipcar",
      "amtrak",
      "rail",
      "bart",
      "subway fare",
    ],
  },
  {
    category: "Fuel",
    keywords: [
      "shell",
      "chevron",
      "exxon",
      "mobil",
      "bp ",
      "texaco",
      "valero",
      "arco",
      "76 ",
      "sunoco",
      "citgo",
      "gas station",
      "fuel",
      "petrol",
      "gasoline",
    ],
  },
  {
    category: "Travel",
    keywords: [
      "airlines",
      "airline",
      "airways",
      "delta",
      "united",
      "american air",
      "southwest",
      "jetblue",
      "alaska air",
      "frontier",
      "spirit air",
      "expedia",
      "booking.com",
      "kayak",
      "priceline",
      "airport",
      "baggage",
      "boarding",
    ],
  },
  {
    category: "Meals & Entertainment",
    keywords: [
      "restaurant",
      "cafe",
      "café",
      "coffee",
      "starbucks",
      "dunkin",
      "mcdonald",
      "burger",
      "pizza",
      "grill",
      "kitchen",
      "bar ",
      "tavern",
      "diner",
      "bakery",
      "deli",
      "bistro",
      "steakhouse",
      "sushi",
      "taco",
      "chipotle",
      "panera",
      "subway sandwich",
      "doordash",
      "grubhub",
      "ubereats",
      "uber eats",
      "catering",
      "brewing",
      "winery",
    ],
  },
  {
    category: "Software & Subscriptions",
    keywords: [
      "google",
      "microsoft",
      "adobe",
      "github",
      "atlassian",
      "slack",
      "zoom",
      "dropbox",
      "notion",
      "figma",
      "openai",
      "anthropic",
      "aws",
      "amazon web services",
      "digitalocean",
      "heroku",
      "netlify",
      "vercel",
      "subscription",
      "saas",
      "license",
      "domain",
      "hosting",
    ],
  },
  {
    category: "Utilities & Phone",
    keywords: [
      "at&t",
      "verizon",
      "t-mobile",
      "comcast",
      "xfinity",
      "spectrum",
      "cox communications",
      "electric",
      "water bill",
      "internet",
      "wireless",
      "phone bill",
      "utility",
    ],
  },
  {
    category: "Shipping & Postage",
    keywords: [
      "fedex",
      "ups store",
      " ups ",
      "usps",
      "dhl",
      "postage",
      "shipping",
      "courier",
      "post office",
    ],
  },
  {
    category: "Office Supplies",
    keywords: [
      "staples",
      "office depot",
      "officemax",
      "best buy",
      "amazon",
      "walmart",
      "target",
      "costco",
      "home depot",
      "lowe's",
      "lowes",
      "supplies",
      "stationery",
      "printer",
      "ink ",
      "toner",
    ],
  },
  {
    category: "Professional Services",
    keywords: [
      "consulting",
      "legal",
      "attorney",
      "accounting",
      "notary",
      "agency",
      "services llc",
      "associates",
      "law office",
      "clinic",
    ],
  },
];

/**
 * Classify a vendor/receipt text into a category. Deterministic, free.
 * @param vendor the extracted vendor name (may be empty)
 * @param hintText additional text (e.g. first OCR lines) to widen the net
 * @returns the best category and whether it was confidently matched
 */
export function categorize(
  vendor: string,
  hintText = "",
): { category: Category; matched: boolean } {
  const hay = ` ${(vendor + " " + hintText).toLowerCase()} `;
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (hay.includes(kw)) {
        return { category: rule.category, matched: true };
      }
    }
  }
  return { category: "Other", matched: false };
}
