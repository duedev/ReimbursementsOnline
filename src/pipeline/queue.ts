import { repo } from "../store/repo.ts";
import { processReceipt } from "./pipeline.ts";
import { getOcrEngine } from "./ocr.ts";
import { PROCESSING } from "../config/constants.ts";

// The decoupled work-list (§4, §8). Extraction takes seconds per receipt; the
// user shouldn't wait on it. A small concurrency pool drains the `jobs` table,
// retries transient failures, and stays out of the UI thread (OCR runs in its
// own worker). At this scale a row in a table *is* the queue.

type ProgressListener = (remaining: number) => void;

class ProcessingQueue {
  private running = 0;
  private draining = false;
  private listeners = new Set<ProgressListener>();

  onProgress(fn: ProgressListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async announce(): Promise<void> {
    const remaining = await repo.pendingJobCount();
    for (const fn of this.listeners) fn(remaining);
  }

  /** Kick the pool. Safe to call repeatedly (e.g. after each enqueue). */
  async wake(): Promise<void> {
    if (this.draining) {
      void this.fill();
      return;
    }
    this.draining = true;
    try {
      await this.fill();
    } finally {
      this.draining = false;
    }
  }

  private async fill(): Promise<void> {
    while (this.running < PROCESSING.concurrency) {
      const job = await repo.claimNextJob();
      if (!job) break;
      this.running++;
      void this.run(job.id, job.receiptId, job.attempts);
    }
  }

  private async run(
    jobId: string,
    receiptId: string,
    attempts: number,
  ): Promise<void> {
    try {
      await processReceipt(receiptId, getOcrEngine());
      await repo.completeJob(jobId);
    } catch {
      // processReceipt already marked the receipt failed; retry a couple times.
      if (attempts >= PROCESSING.maxAttempts) {
        await repo.completeJob(jobId);
      } else {
        await repo.releaseJob({ id: jobId, receiptId, attempts, lockedAt: null });
      }
    } finally {
      this.running--;
      await this.announce();
      // Pull the next job if any remain.
      const job = await repo.claimNextJob();
      if (job) {
        this.running++;
        void this.run(job.id, job.receiptId, job.attempts);
      }
    }
  }
}

export const queue = new ProcessingQueue();
