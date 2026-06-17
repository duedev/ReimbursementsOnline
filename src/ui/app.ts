import { repo } from "../store/repo.ts";
import { queue } from "../pipeline/queue.ts";
import { buildWorkbook } from "../export/workbook.ts";
import { toCsv, csvFileName } from "../export/csv.ts";
import { validateFile, safeBasename } from "../util/files.ts";
import { LIMITS, CURRENCY_DEFAULT } from "../config/constants.ts";
import { formatMoney } from "../util/money.ts";
import { uid } from "../util/id.ts";
import { el, mount } from "./dom.ts";
import { toast } from "./toast.ts";
import { renderHeader } from "./views/header.ts";
import { renderSetup } from "./views/setup.ts";
import { renderBoard } from "./views/board.ts";
import { ReviewModal } from "./views/review.ts";
import type { Batch, Receipt } from "../types.ts";

// Top-level controller. Holds the active batch, listens to the repo + queue,
// and re-renders the active view. No framework: a render() that rebuilds the
// board from the source of truth on every change (cheap at this scale).

export class App {
  private root: HTMLElement;
  private batches: Batch[] = [];
  private receipts: Receipt[] = [];
  currentBatchId: string | null = null;
  private review: ReviewModal | null = null;
  private renderQueued = false;
  remaining = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  get currentBatch(): Batch | null {
    return this.batches.find((b) => b.id === this.currentBatchId) ?? null;
  }

  get knownBatches(): Batch[] {
    return this.batches;
  }

  getReceipts(): Receipt[] {
    return this.receipts;
  }

  async init(): Promise<void> {
    repo.subscribe(() => this.scheduleRender());
    queue.onProgress((n) => {
      this.remaining = n;
      this.scheduleRender();
    });
    this.batches = await repo.listBatches();
    this.currentBatchId = this.batches[0]?.id ?? null;
    await this.refresh();
    this.root.removeAttribute("aria-busy");
    // Resume any work that was pending before a reload.
    void queue.wake();
    window.addEventListener("beforeunload", (e) => {
      if (this.remaining > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  /** Reload data for the active batch and re-render. */
  private async refresh(): Promise<void> {
    this.batches = await repo.listBatches();
    if (!this.currentBatchId && this.batches[0]) {
      this.currentBatchId = this.batches[0].id;
    }
    this.receipts = this.currentBatchId
      ? await repo.listReceipts(this.currentBatchId)
      : [];
    this.render();
    if (this.review) this.review.update(this.receipts);
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(async () => {
      this.renderQueued = false;
      await this.refresh();
    });
  }

  private render(): void {
    const header = renderHeader(this);
    const main = this.currentBatch ? renderBoard(this) : renderSetup(this);
    mount(this.root, header, main);
  }

  // ---- Actions ----------------------------------------------------------

  async newBatch(fields: { employee: string; jobName: string; jobNumber: string }): Promise<void> {
    const batch = await repo.createBatch(fields);
    this.currentBatchId = batch.id;
    await this.refresh();
    toast("Batch created — add your receipts.", "success");
  }

  async switchBatch(id: string): Promise<void> {
    this.currentBatchId = id;
    await this.refresh();
  }

  startNewBatch(): void {
    this.currentBatchId = null;
    this.render();
  }

  async addFiles(files: FileList | File[]): Promise<void> {
    const batch = this.currentBatch;
    if (!batch) return;
    const list = Array.from(files);
    let added = 0;
    let rejected = 0;
    const existing = this.receipts.length;

    for (const file of list) {
      if (existing + added >= LIMITS.maxReceiptsPerBatch) {
        toast(`Batch is full (max ${LIMITS.maxReceiptsPerBatch}).`, "warn");
        break;
      }
      const check = validateFile(file);
      if (!check.ok) {
        rejected++;
        continue;
      }
      const fileKey = await repo.putBlob(file, "original");
      const receipt = blankReceipt(batch.id, fileKey, file);
      await repo.putReceipt(receipt);
      await repo.enqueue(receipt.id);
      added++;
    }

    if (rejected > 0) {
      toast(`${rejected} file${rejected > 1 ? "s" : ""} skipped (images or PDF only).`, "warn");
    }
    if (added > 0) {
      void queue.wake();
      toast(`Added ${added} receipt${added > 1 ? "s" : ""} — reading now…`, "info");
    }
    await this.refresh();
  }

  openReview(receiptId: string): void {
    const ids = this.receipts.map((r) => r.id);
    const index = Math.max(0, ids.indexOf(receiptId));
    this.review = new ReviewModal(this.receipts, index, () => {
      this.review = null;
    });
    this.review.open();
  }

  /** Open review starting at the first receipt that still needs a look. */
  reviewFirstFlagged(): void {
    const first =
      this.receipts.find((r) => r.reviewRequired && !r.approved) ??
      this.receipts[0];
    if (first) this.openReview(first.id);
  }

  async deleteBatch(): Promise<void> {
    const batch = this.currentBatch;
    if (!batch) return;
    if (!confirm(`Delete batch "${batch.jobName || "Untitled"}" and its ${this.receipts.length} receipts?`)) {
      return;
    }
    for (const r of this.receipts) await repo.deleteReceipt(r.id);
    this.currentBatchId = null;
    await this.refresh();
    toast("Batch deleted.", "info");
  }

  async generate(): Promise<void> {
    const batch = this.currentBatch;
    if (!batch) return;
    const exportable = this.receipts.filter(
      (r) => r.status !== "failed" && r.amount.value > 0,
    );
    if (exportable.length === 0) {
      toast("Nothing to export yet — add some receipts.", "warn");
      return;
    }
    const unreviewed = exportable.filter((r) => r.reviewRequired && !r.approved).length;
    if (unreviewed > 0) {
      const go = confirm(
        `${unreviewed} receipt${unreviewed > 1 ? "s" : ""} still need review. ` +
          `Generate anyway? They'll be highlighted in the workbook.`,
      );
      if (!go) {
        this.reviewFirstFlagged();
        return;
      }
    }
    toast("Building your spreadsheet…", "info");
    try {
      const result = await buildWorkbook(batch, this.receipts, (k) => repo.getBlob(k));
      downloadBlob(result.blob, result.fileName);
      toast(
        `Saved ${result.fileName} · ${result.count} receipts · cost ${formatMoney(result.totalCost)}`,
        "success",
        5000,
      );
    } catch (err) {
      console.error(err);
      toast("Could not build the spreadsheet.", "error");
    }
  }

  /** Export the batch as a plain CSV (a lightweight companion to the .xlsx). */
  exportCsv(): void {
    const batch = this.currentBatch;
    if (!batch) return;
    const exportable = this.receipts.filter(
      (r) => r.status !== "failed" && r.amount.value > 0,
    );
    if (exportable.length === 0) {
      toast("Nothing to export yet — add some receipts.", "warn");
      return;
    }
    // Prepend a UTF-8 BOM so Excel detects the encoding when opening the file.
    const blob = new Blob(["\uFEFF", toCsv(this.receipts)], {
      type: "text/csv;charset=utf-8",
    });
    downloadBlob(blob, csvFileName(batch));
    toast(`Exported ${exportable.length} rows to CSV.`, "success");
  }
}

function blankReceipt(batchId: string, fileKey: string, file: File): Receipt {
  const now = Date.now();
  return {
    id: uid("rcpt"),
    batchId,
    fileKey,
    fileName: safeBasename(file.name),
    mimeType: file.type || "image/jpeg",
    status: "queued",
    vendor: { value: "", confidence: 0 },
    date: { value: "", confidence: 0 },
    amount: { value: 0, confidence: 0 },
    tax: { value: 0, confidence: 0 },
    currency: CURRENCY_DEFAULT,
    category: { value: "Other", confidence: 0 },
    confidence: 0,
    flags: [],
    methodUsed: "rules",
    cost: 0,
    approved: false,
    reviewRequired: false,
    createdAt: now,
    updatedAt: now,
  };
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
