import { db } from "./db.ts";
import type {
  Batch,
  Receipt,
  Job,
  StoredBlob,
  ReceiptStatus,
} from "../types.ts";
import { uid } from "../util/id.ts";

// Repository over the local stores. This is the one place that reads/writes the
// source of truth, and the one place that announces changes — the UI subscribes
// here instead of holding a connection open (§13: live updates by polling/push,
// scale-to-zero friendly). Everything is awaitable so a remote backend could
// drop in behind the same method shapes.

type Listener = () => void;

class Repo {
  private listeners = new Set<Listener>();

  /** Subscribe to "something changed"; returns an unsubscribe fn. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("repo listener failed", err);
      }
    }
  }

  // ---- Blobs (file store) ----------------------------------------------

  async putBlob(
    blob: Blob,
    kind: StoredBlob["kind"],
    key = uid("blob"),
  ): Promise<string> {
    const record: StoredBlob = { key, blob, kind, createdAt: Date.now() };
    await (await db()).put("blobs", record);
    return key;
  }

  async getBlob(key: string): Promise<Blob | undefined> {
    const rec = await (await db()).get("blobs", key);
    return rec?.blob;
  }

  async deleteBlob(key: string): Promise<void> {
    await (await db()).delete("blobs", key);
  }

  // ---- Batches ----------------------------------------------------------

  async createBatch(
    fields: Pick<Batch, "employee" | "jobName" | "jobNumber">,
  ): Promise<Batch> {
    const now = Date.now();
    const batch: Batch = { id: uid("batch"), createdAt: now, updatedAt: now, ...fields };
    await (await db()).put("batches", batch);
    this.notify();
    return batch;
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    return (await db()).get("batches", id);
  }

  async updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
    const cur = await this.getBatch(id);
    if (!cur) return;
    await (await db()).put("batches", { ...cur, ...patch, updatedAt: Date.now() });
    this.notify();
  }

  async listBatches(): Promise<Batch[]> {
    const all = await (await db()).getAllFromIndex("batches", "byCreated");
    return all.reverse(); // newest first
  }

  // ---- Receipts ---------------------------------------------------------

  async putReceipt(receipt: Receipt): Promise<void> {
    await (await db()).put("receipts", receipt);
    this.notify();
  }

  async getReceipt(id: string): Promise<Receipt | undefined> {
    return (await db()).get("receipts", id);
  }

  async updateReceipt(id: string, patch: Partial<Receipt>): Promise<Receipt | undefined> {
    const cur = await this.getReceipt(id);
    if (!cur) return undefined;
    const next: Receipt = { ...cur, ...patch, updatedAt: Date.now() };
    await (await db()).put("receipts", next);
    this.notify();
    return next;
  }

  async listReceipts(batchId: string): Promise<Receipt[]> {
    const all = await (await db()).getAllFromIndex("receipts", "byBatch", batchId);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async findByHash(hash: string): Promise<Receipt[]> {
    return (await db()).getAllFromIndex("receipts", "byHash", hash);
  }

  async deleteReceipt(id: string): Promise<void> {
    const r = await this.getReceipt(id);
    if (r) {
      await this.deleteBlob(r.fileKey).catch(() => {});
    }
    const conn = await db();
    await conn.delete("receipts", id);
    // Drop any pending job too.
    const jobs = await conn.getAllFromIndex("jobs", "byReceipt", id);
    await Promise.all(jobs.map((j) => conn.delete("jobs", j.id)));
    this.notify();
  }

  async countByStatus(batchId: string): Promise<Record<ReceiptStatus, number>> {
    const receipts = await this.listReceipts(batchId);
    const counts: Record<ReceiptStatus, number> = {
      queued: 0,
      processing: 0,
      done: 0,
      needs_review: 0,
      failed: 0,
    };
    for (const r of receipts) counts[r.status]++;
    return counts;
  }

  // ---- Jobs (the cheap work-list) --------------------------------------

  async enqueue(receiptId: string): Promise<Job> {
    const job: Job = { id: uid("job"), receiptId, attempts: 0, lockedAt: null };
    await (await db()).put("jobs", job);
    return job;
  }

  /** Atomically claim the oldest unlocked job, if any. */
  async claimNextJob(staleLockMs = 60_000): Promise<Job | null> {
    const conn = await db();
    const tx = conn.transaction("jobs", "readwrite");
    let claimed: Job | null = null;
    let cursor = await tx.store.openCursor();
    const now = Date.now();
    while (cursor) {
      const job = cursor.value;
      const available = job.lockedAt === null || now - job.lockedAt > staleLockMs;
      if (available) {
        claimed = { ...job, lockedAt: now, attempts: job.attempts + 1 };
        await cursor.update(claimed);
        break;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return claimed;
  }

  async completeJob(jobId: string): Promise<void> {
    await (await db()).delete("jobs", jobId);
  }

  async releaseJob(job: Job): Promise<void> {
    await (await db()).put("jobs", { ...job, lockedAt: null });
  }

  async pendingJobCount(): Promise<number> {
    return (await db()).count("jobs");
  }
}

export const repo = new Repo();
