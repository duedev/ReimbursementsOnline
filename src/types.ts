// Domain model — the single source of truth for the whole app.
// Mirrors §7 of DESIGN_FROM_SCRATCH.md. `receipts` *is* the board, the results
// list, and the export source; `batches` group a submission; `jobs` are the
// cheap work-list. In this client-side build these live in IndexedDB, but the
// shapes are storage-agnostic so a server could host them unchanged.

export type ReceiptStatus =
  | "queued"
  | "processing"
  | "done"
  | "needs_review"
  | "failed";

/** Which extraction tier produced a result. Recorded per-receipt so the
 *  "this batch cost you $0.00" line is honest and a spend-cap is trivial. */
export type ExtractionMethod = "rules" | "paid";

/** Expense categories used for the per-category sheets and the lookup table. */
export type Category =
  | "Meals & Entertainment"
  | "Travel"
  | "Lodging"
  | "Ground Transportation"
  | "Fuel"
  | "Office Supplies"
  | "Software & Subscriptions"
  | "Utilities & Phone"
  | "Shipping & Postage"
  | "Professional Services"
  | "Other";

/** A normalized rectangle (0..1) over the *cleaned* image, used to draw
 *  on-image markers and zoomed callouts next to each extracted field. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FlagCode =
  | "low_confidence"
  | "no_amount"
  | "no_date"
  | "no_vendor"
  | "total_mismatch"
  | "future_date"
  | "stale_date"
  | "duplicate"
  | "uncategorized"
  | "large_amount";

export interface Flag {
  code: FlagCode;
  message: string;
  severity: "info" | "warn" | "error";
}

/** A single extracted field plus where on the image it came from and how
 *  sure we are about it. Powers inline editing and the zoomed callouts. */
export interface Field<T> {
  value: T;
  /** 0..1 confidence for this specific field. */
  confidence: number;
  /** Where on the cleaned image the value was read from, if known. */
  bbox?: BBox;
  /** True once a human has confirmed/edited the value in review. */
  edited?: boolean;
}

export interface Batch {
  id: string;
  employee: string;
  jobName: string;
  jobNumber: string;
  createdAt: number;
  updatedAt: number;
}

export interface Receipt {
  id: string;
  batchId: string;

  /** Pointer to the original blob in the file store (IndexedDB blob store). */
  fileKey: string;
  /** Pointer to the cleaned/downscaled image the OCR boxes map to (review + export). */
  cleanedKey?: string;
  /** Basename-only, sanitized original filename — for display and export. */
  fileName: string;
  mimeType: string;

  status: ReceiptStatus;

  /** SHA-256 of the cleaned image bytes — extraction cache key + dedup key. */
  imageHash?: string;

  // Extracted fields (each carries its own confidence + provenance bbox).
  vendor: Field<string>;
  date: Field<string>; // ISO yyyy-mm-dd
  amount: Field<number>; // grand total, in `currency`
  tax: Field<number>;
  currency: string; // ISO 4217-ish, e.g. "USD"
  category: Field<Category>;

  /** Overall 0..1 confidence across the receipt. */
  confidence: number;
  flags: Flag[];

  /** Full OCR text, kept for re-parsing and the review panel. */
  ocrText?: string;

  methodUsed: ExtractionMethod;
  /** When a paid tier produced the result, which provider/model (for the
   *  review panel + an honest audit trail). Absent on the free rules path. */
  methodDetail?: string;
  cost: number; // dollars spent on this receipt (free path = 0)

  approved: boolean;
  reviewRequired: boolean;

  /** Dimensions of the cleaned image, for mapping bboxes to pixels. */
  imageWidth?: number;
  imageHeight?: number;

  error?: string;

  createdAt: number;
  updatedAt: number;
}

export interface Job {
  id: string;
  receiptId: string;
  attempts: number;
  /** Epoch ms when a worker claimed this job (null = available). */
  lockedAt: number | null;
}

/** Stored original/derived image bytes. The "file store" of §4. */
export interface StoredBlob {
  key: string;
  blob: Blob;
  kind: "original" | "cleaned" | "export";
  createdAt: number;
}

/** What the OCR capability returns — interface, not a specific model (§5). */
export interface OcrWord {
  text: string;
  confidence: number; // 0..100 from the engine
  bbox: BBox; // normalized to the image it ran on
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: BBox;
  words: OcrWord[];
}

export interface OcrResult {
  text: string;
  confidence: number; // 0..100 overall
  lines: OcrLine[];
  words: OcrWord[];
}
