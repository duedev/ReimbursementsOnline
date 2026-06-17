// Strong defaults — "zero-config beats configurable" (§3). A first-time user
// should never face a choice to get a result. These are the guardrails that
// also cap cost/abuse (§11) and the levers that keep marginal cost ~ $0 (§9).

export const APP_NAME = "Reimbursements Online";

/** Input hardening + per-batch volume caps (§11). Polite refusal, not an invoice. */
export const LIMITS = {
  /** Max receipts per batch. Keeps storage/throughput bounded. */
  maxReceiptsPerBatch: 200,
  /** Max original upload size each. Larger photos are downscaled anyway. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Accepted input types. */
  acceptedMime: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
  ] as const,
  acceptedExtensions: [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".heic",
    ".heif",
    ".pdf",
  ] as const,
};

/** Image pre-pass settings (§5 step 1, §14). Downscaling is also a cost lever:
 *  smaller images OCR faster and would make any optional paid call cheaper. */
export const IMAGE_PREP = {
  /** Longest edge after downscale, in px. Plenty for receipt OCR. */
  maxEdge: 1600,
  /** JPEG quality for the cleaned image used by OCR + export. */
  quality: 0.85,
  /** Convert to grayscale before OCR (helps Tesseract, shrinks bytes). */
  grayscale: true,
  /** Attempt to auto-crop the receipt away from its background. */
  autoCrop: true,
};

/** Confidence thresholds that drive the board + review routing. */
export const CONFIDENCE = {
  /** At/above this, a receipt is auto-"done"; below, it needs review. */
  reviewBelow: 0.8,
  /** A field rendered with a "low" treatment below this. */
  fieldLow: 0.6,
};

/** Heuristic thresholds for flags. */
export const FLAGS = {
  /** Flag receipts older than this many days as possibly stale. */
  staleAfterDays: 120,
  /** Flag unusually large amounts for a closer look. */
  largeAmount: 1000,
  /** Allowed gap between summed line items and printed total to "reconcile". */
  reconcileTolerance: 0.02,
};

/** OCR language-data location. By default the data is vendored at build time
 *  and served same-origin (offline, $0, no third-party CDN). Set
 *  VITE_TESSDATA_LOCAL=0 to fetch from the public CDN instead. Either way the
 *  service worker caches it after first use. */
export const OCR = {
  language: "eng",
  /** Public CDN fallback (the tesseract.js default host). */
  cdnLangPath: "https://tessdata.projectnaptha.com/4.0.0",
  /** Same-origin path (relative to BASE_URL) for the vendored data. */
  localLangPath: "vendor/tessdata/4.0.0",
  // `import.meta.env` is replaced at build time by Vite; guard for non-Vite
  // contexts (e.g. the Node test runner) where it is undefined.
  useLocal: import.meta.env?.VITE_TESSDATA_LOCAL !== "0",
};

/** How many receipts to OCR at once. OCR is CPU-bound; a small pool keeps the
 *  UI responsive while still draining a batch quickly. */
export const PROCESSING = {
  concurrency: 2,
  maxAttempts: 2,
};

export const CURRENCY_DEFAULT = "USD";
