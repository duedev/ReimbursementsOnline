import type { Extraction } from "../extract.ts";
import type { VisionProvider, VisionContext } from "./types.ts";
import {
  getVisionConfig,
  withinBudget,
  recordSpend,
  effectiveApiKey,
  type VisionConfig,
} from "./config.ts";
import { visionToExtraction } from "./schema.ts";
import { CONFIDENCE } from "../../config/constants.ts";
import { createOpenRouterProvider } from "./providers/openrouter.ts";
import { createGeminiProvider } from "./providers/gemini.ts";
import { createAnthropicProvider } from "./providers/anthropic.ts";

// Tier 3 orchestration: pick the provider, decide when to spend, and fall back
// to the rules result on any failure so a paid call can only ever *help*.

export function getVisionProvider(cfg: VisionConfig): VisionProvider {
  const init = { apiKey: effectiveApiKey(cfg), model: cfg.model, baseUrl: cfg.baseUrl || undefined };
  switch (cfg.provider) {
    case "gemini":
      return createGeminiProvider(init);
    case "anthropic":
      return createAnthropicProvider(init);
    case "openrouter":
    default:
      return createOpenRouterProvider(init);
  }
}

export function visionConfigured(cfg: VisionConfig = getVisionConfig()): boolean {
  return cfg.enabled && effectiveApiKey(cfg).length > 0;
}

/** Trigger condition: the free rules path is unsure about this receipt. */
export function shouldAssist(ex: Extraction): boolean {
  return ex.confidence < CONFIDENCE.reviewBelow || ex.amount.value <= 0;
}

export interface VisionAssist {
  extraction: Extraction;
  costUsd: number;
  provider: string;
  model: string;
  rawText: string;
}

/**
 * Run the paid vision fallback for a low-confidence receipt, if configured and
 * within budget. Returns null (and leaves the rules result untouched) when the
 * tier is off, not triggered, over budget, or the call fails.
 */
export async function runVisionAssist(
  image: Blob,
  ex: Extraction,
  ctx: VisionContext,
): Promise<VisionAssist | null> {
  const cfg = getVisionConfig();
  if (!visionConfigured(cfg) || !shouldAssist(ex)) return null;
  if (!withinBudget(cfg)) {
    console.warn("[vision] spend cap reached — skipping the paid fallback.");
    return null;
  }
  try {
    const result = await getVisionProvider(cfg).extract(image, ctx);
    recordSpend(result.costUsd);
    return {
      extraction: visionToExtraction(result.fields, ctx.currencyDefault),
      costUsd: result.costUsd,
      provider: cfg.provider,
      model: result.model,
      rawText: result.rawText,
    };
  } catch (err) {
    console.warn("[vision] paid fallback failed; keeping the free rules result.", err);
    return null;
  }
}

/** A cheap auth/connectivity probe for the settings panel: one real call on a
 *  tiny synthetic image. Resolves with whether the provider answered. */
export async function testVisionConnection(
  cfg: VisionConfig,
): Promise<{ ok: boolean; message: string }> {
  if (!effectiveApiKey(cfg)) return { ok: false, message: "Add an API key first." };
  try {
    const blob = await tinyTestImage();
    await getVisionProvider(cfg).extract(blob, { currencyDefault: "USD" });
    return { ok: true, message: `${cfg.provider} responded — key looks good.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function tinyTestImage(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 200, 80);
    ctx.fillStyle = "#000";
    ctx.font = "16px sans-serif";
    ctx.fillText("TEST CAFE", 10, 28);
    ctx.fillText("2026-01-02  TOTAL 4.20", 10, 56);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))),
      "image/jpeg",
      0.85,
    ),
  );
}
