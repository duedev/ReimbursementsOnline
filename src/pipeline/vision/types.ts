// Tier 3 (DESIGN §5/§9): an optional, confidence-triggered "paid accuracy dial".
// A vision LLM reads the cleaned receipt image and returns structured fields in
// one shot — collapsing OCR + rules + categorization for the low-confidence path.
//
// This is the seam the README's two-tier vision describes: it sits *behind* the
// free on-device default and only fires for receipts the rules path is unsure
// about. It is OFF by default and requires the user to supply their own API key
// (this app has no server) — see vision/config.ts and the privacy note there.

export type ProviderId = "openrouter" | "gemini" | "anthropic";

/** The structured fields a vision model is asked to return. */
export interface VisionFields {
  vendor: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  amount: number;
  tax: number;
  currency?: string;
  category?: string;
}

/** A provider's result: the model's raw JSON (validated/normalized later by
 *  schema.ts), the raw response text (kept for the review panel), and the
 *  measured dollar cost of the call (free models/tiers report 0). */
export interface VisionExtraction {
  fields: Record<string, unknown>;
  rawText: string;
  costUsd: number;
  model: string;
}

export interface VisionContext {
  currencyDefault: string;
}

/** One provider behind the seam. `extract` does the network round-trip. */
export interface VisionProvider {
  readonly id: ProviderId;
  extract(image: Blob, ctx: VisionContext): Promise<VisionExtraction>;
}
