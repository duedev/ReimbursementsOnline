import type { ProviderId } from "./types.ts";

// Tier 3 configuration. Because this app has no server, the only way to keep a
// vision call "$0-infrastructure" is a user-supplied key, stored locally. It is
// OFF by default and never bundled. A self-hosted proxy can be pointed at via
// `baseUrl` so the key need not live in the browser at all.

export interface VisionConfig {
  enabled: boolean;
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Optional base-URL override (e.g. a key-holding proxy). "" = provider default. */
  baseUrl: string;
  /** Cumulative spend cap in USD; 0 = uncapped. */
  spendCapUsd: number;
  /** Running total spent on paid calls (the "this cost you $X" line, honestly). */
  spentUsd: number;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Whether the default model/tier is free of marginal cost. */
  free: boolean;
  keyUrl: string;
  note: string;
  /** Suggested model ids (the field is free-text — any id works). */
  models: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "qwen/qwen2.5-vl-72b-instruct:free",
    free: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "One key, OpenAI-compatible. `:free` models cost $0 (rate-limited); the same key also reaches paid Claude/Gemini.",
    models: [
      "qwen/qwen2.5-vl-72b-instruct:free",
      "qwen/qwen2.5-vl-32b-instruct:free",
      "meta-llama/llama-3.2-11b-vision-instruct:free",
      "mistralai/mistral-small-3.1-24b-instruct:free",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-flash",
    ],
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    free: true,
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Generous no-card free tier with native vision. Free-tier prompts may be used by Google to improve their products.",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-haiku-4-5",
    free: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Highest accuracy on hard/degraded receipts. ~a fraction of a cent per receipt on Haiku 4.5.",
    models: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
  },
};

const STORAGE_KEY = "ro.vision.config.v1";

const DEFAULTS: VisionConfig = {
  enabled: false,
  provider: "openrouter",
  model: PROVIDERS.openrouter.defaultModel,
  apiKey: "",
  baseUrl: "",
  spendCapUsd: 1,
  spentUsd: 0,
};

export function getVisionConfig(): VisionConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<VisionConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveVisionConfig(patch: Partial<VisionConfig>): VisionConfig {
  const next: VisionConfig = { ...getVisionConfig(), ...patch };
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable (private mode); config just won't persist */
    }
  }
  return next;
}

export function withinBudget(cfg: VisionConfig = getVisionConfig(), projected = 0): boolean {
  if (cfg.spendCapUsd <= 0) return true; // 0 means uncapped
  return cfg.spentUsd + projected <= cfg.spendCapUsd + 1e-9;
}

export function recordSpend(cost: number): void {
  if (!(cost > 0)) return;
  const cfg = getVisionConfig();
  saveVisionConfig({ spentUsd: Math.round((cfg.spentUsd + cost) * 1e6) / 1e6 });
}
