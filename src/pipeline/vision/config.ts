import type { ProviderId } from "./types.ts";
import { usesFreeRouting } from "./providers/openrouter.ts";

// A built-in OpenRouter key for the FREE Models Router, injected at BUILD time
// (never committed to source). Vite replaces `__OPENROUTER_FREE_KEY__` with the
// value of OPENROUTER_API_KEY / VITE_OPENROUTER_FREE_KEY from the build env (see
// vite.config.ts); it is "" when the build provides no key. The `typeof` guard
// keeps this safe in non-Vite contexts (the Node test runner), where the global
// is undefined. A user's own key (Settings) always wins, and this fallback is
// only ever used for OpenRouter free routing — never paid models.
declare const __OPENROUTER_FREE_KEY__: string;
const BUILTIN_OPENROUTER_KEY: string =
  typeof __OPENROUTER_FREE_KEY__ === "string" ? __OPENROUTER_FREE_KEY__ : "";

/** Whether a built-in OpenRouter free key was baked in at build time. */
export function hasBuiltInOpenRouterKey(): boolean {
  return BUILTIN_OPENROUTER_KEY.length > 0;
}

// Tier 3 configuration. Because this app has no server, a vision call uses either
// a user-supplied key (stored locally) or the build-time free key above. The
// tier is OFF by default UNLESS a build-time key is present, in which case the
// first run auto-enables the OpenRouter free router (zero-click). A self-hosted
// proxy can be pointed at via `baseUrl` so a key need not live in the browser.

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
    label: "OpenRouter (free router)",
    defaultModel: "openrouter/free",
    free: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "Free Models Router: auto-picks a quick, reliable free model that supports vision. $0 (≈50 requests/day free, 1000/day with ≥10 credits). The same key also reaches paid Claude/Gemini if you type their model id.",
    models: [
      "openrouter/free",
      "qwen/qwen2.5-vl-72b-instruct:free",
      "meta-llama/llama-3.2-11b-vision-instruct:free",
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
  // Zero-click: a build that bakes in a free key opts into the tier by default
  // (low-confidence receipts use the OpenRouter free router). A keyless build
  // stays off, preserving the on-device-only promise until a user turns it on.
  enabled: hasBuiltInOpenRouterKey(),
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

/** The key to actually send: the user's own key wins; otherwise the built-in
 *  free key, but only for OpenRouter's free routing (never for paid models).
 *  `builtIn` is injectable for tests; production uses the build-time value. */
export function effectiveApiKey(
  cfg: VisionConfig,
  builtIn: string = BUILTIN_OPENROUTER_KEY,
): string {
  const own = cfg.apiKey.trim();
  if (own) return own;
  if (cfg.provider === "openrouter" && usesFreeRouting(cfg.model)) return builtIn;
  return "";
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
