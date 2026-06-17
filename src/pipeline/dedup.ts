// Semantic duplicate detection — adapted from the original app's
// `_detect_duplicates`. The image-hash dedup in the pipeline only catches a
// *byte-identical* re-upload; this catches the same receipt photographed twice
// (different pixels, same data) by keying on vendor + date + amount. A non-zero
// amount is required — without it there's nothing reliable to match on.

export interface DupRecord {
  /** Stable identity so a record never matches itself. */
  id: string;
  /** Human-friendly label for the flag message (e.g. the file name). */
  label: string;
  vendor: string;
  date: string;
  amount: number;
}

/** Normalized vendor|date|amount key, or null when there's no usable amount. */
export function semanticKey(r: Pick<DupRecord, "vendor" | "date" | "amount">): string | null {
  const amount = Math.round((r.amount || 0) * 100) / 100;
  if (amount <= 0) return null;
  const vendor = (r.vendor || "").trim().toLowerCase();
  const date = (r.date || "").trim();
  return `${vendor}|${date}|${amount.toFixed(2)}`;
}

/**
 * Return the first record in `others` that is a likely duplicate of `current`
 * (same vendor, date and amount), or null. `others` would typically be the
 * already-processed receipts in the same batch.
 */
export function findSemanticDuplicate(
  current: DupRecord,
  others: DupRecord[],
): DupRecord | null {
  const key = semanticKey(current);
  if (!key) return null;
  for (const o of others) {
    if (o.id === current.id) continue;
    if (semanticKey(o) === key) return o;
  }
  return null;
}
