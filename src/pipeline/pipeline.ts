import { repo } from "../store/repo.ts";
import { cleanImage } from "./imagePrep.ts";
import { hashBlob } from "./hash.ts";
import { parseReceipt } from "./extract.ts";
import { findSemanticDuplicate, type DupRecord } from "./dedup.ts";
import { getOcrEngine, type OcrEngine } from "./ocr.ts";
import { CONFIDENCE } from "../config/constants.ts";
import type { Receipt, Flag, OcrResult } from "../types.ts";

// The worker's job, end to end (§8 "Process"): clean → hash (cache/dedup) →
// OCR (skipped on a cache hit) → rules → dedup → decide status. Free path first,
// everything deterministic. Each receipt records method_used + cost so the
// "this cost you $0.00" line is honest.

export async function processReceipt(
  receiptId: string,
  engine: OcrEngine = getOcrEngine(),
): Promise<void> {
  const receipt = await repo.getReceipt(receiptId);
  if (!receipt) return;

  await repo.updateReceipt(receiptId, { status: "processing", error: undefined });

  const original = await repo.getBlob(receipt.fileKey);
  if (!original) {
    await fail(receiptId, "Original image is missing.");
    return;
  }

  try {
    // 1. Clean (auto-rotate, grayscale, auto-crop, downscale).
    const cleaned = await cleanImage(original);
    URL.revokeObjectURL(cleaned.url); // we persist the blob, not this URL
    const cleanedKey = await repo.putBlob(cleaned.blob, "cleaned");

    // 2. Hash the cleaned bytes → cache key + dedup key.
    const imageHash = await hashBlob(cleaned.blob);

    // 3. Cache by image hash: reuse OCR text from an identical image (free).
    const sameHash = (await repo.findByHash(imageHash)).filter(
      (r) => r.id !== receiptId,
    );
    const cached = sameHash.find((r) => r.ocrText && r.ocrText.length > 0);

    let ocr: OcrResult;
    if (cached?.ocrText) {
      ocr = {
        text: cached.ocrText,
        confidence: cached.confidence * 100,
        lines: [],
        words: [],
      };
    } else {
      ocr = await engine.recognize(cleaned.blob, cleaned.width, cleaned.height);
    }

    // 4. Rules extraction.
    const ex = parseReceipt(ocr, { currencyDefault: receipt.currency });

    // 5. Duplicate detection within the same batch. First an exact image-hash
    //    match (byte-identical re-upload); failing that, a semantic match on
    //    vendor + date + amount (the same receipt photographed twice).
    const flags: Flag[] = [...ex.flags];
    let duplicateOf: string | null = null;
    const dupInBatch = sameHash.find((r) => r.batchId === receipt.batchId);
    if (dupInBatch) {
      duplicateOf = dupInBatch.fileName;
      flags.unshift({
        code: "duplicate",
        severity: "warn",
        message: `Looks identical to "${dupInBatch.fileName}".`,
      });
    } else {
      const siblings = await repo.listReceipts(receipt.batchId);
      const others: DupRecord[] = siblings
        .filter((r) => r.id !== receiptId)
        .map((r) => ({
          id: r.id,
          label: r.fileName,
          vendor: r.vendor.value,
          date: r.date.value,
          amount: r.amount.value,
        }));
      const semDup = findSemanticDuplicate(
        {
          id: receiptId,
          label: receipt.fileName,
          vendor: ex.vendor.value,
          date: ex.date.value,
          amount: ex.amount.value,
        },
        others,
      );
      if (semDup) {
        duplicateOf = semDup.label;
        flags.unshift({
          code: "duplicate",
          severity: "warn",
          message: `Same vendor, date and amount as "${semDup.label}" — possible duplicate.`,
        });
      }
    }

    const hasError = flags.some((f) => f.severity === "error");
    const needsReview =
      hasError ||
      Boolean(duplicateOf) ||
      ex.confidence < CONFIDENCE.reviewBelow ||
      ex.amount.value <= 0;

    const patch: Partial<Receipt> = {
      cleanedKey,
      imageHash,
      imageWidth: cleaned.width,
      imageHeight: cleaned.height,
      vendor: ex.vendor,
      date: ex.date,
      amount: ex.amount,
      tax: ex.tax,
      currency: ex.currency,
      category: ex.category,
      confidence: ex.confidence,
      flags,
      ocrText: ocr.text,
      methodUsed: "rules",
      cost: 0,
      reviewRequired: needsReview,
      status: needsReview ? "needs_review" : "done",
      error: undefined,
    };
    await repo.updateReceipt(receiptId, patch);
  } catch (err) {
    await fail(receiptId, err instanceof Error ? err.message : String(err));
    throw err; // let the queue decide on retry
  }
}

async function fail(receiptId: string, message: string): Promise<void> {
  await repo.updateReceipt(receiptId, {
    status: "failed",
    error: message,
    reviewRequired: true,
    flags: [{ code: "low_confidence", severity: "error", message }],
  });
}
