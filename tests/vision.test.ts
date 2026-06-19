import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visionToExtraction,
  parseVisionJson,
} from "../src/pipeline/vision/schema.ts";
import { usesFreeRouting } from "../src/pipeline/vision/providers/openrouter.ts";
import {
  effectiveApiKey,
  hasBuiltInOpenRouterKey,
  type VisionConfig,
} from "../src/pipeline/vision/config.ts";

// Tier 3 (vision LLM) JSON → Extraction mapping. The network call is provider
// code; this validates the normalization that every provider feeds into.

test("a clean model response maps to a high-confidence extraction", () => {
  const ex = visionToExtraction({
    vendor: "Blue Bottle Coffee",
    date: "2026-03-14",
    amount: 8.99,
    tax: 0.74,
    currency: "usd",
    category: "Meals & Entertainment",
  });
  assert.equal(ex.vendor.value, "Blue Bottle Coffee");
  assert.equal(ex.amount.value, 8.99);
  assert.equal(ex.tax.value, 0.74);
  assert.equal(ex.date.value, "2026-03-14");
  assert.equal(ex.currency, "USD"); // normalized to upper-case
  assert.equal(ex.category.value, "Meals & Entertainment");
  assert.ok(ex.confidence >= 0.8); // all fields present ⇒ auto-done
  assert.ok(!ex.flags.some((f) => f.code === "no_amount"));
});

test("string amounts and non-ISO dates are coerced/flagged", () => {
  const ex = visionToExtraction({
    vendor: "Shell",
    date: "03/14/2026", // not ISO → dropped + flagged
    amount: "$42.10",
    tax: "3.20",
    category: "NotARealCategory", // invalid → falls back to keyword categorize
  });
  assert.equal(ex.amount.value, 42.1);
  assert.equal(ex.tax.value, 3.2);
  assert.equal(ex.date.value, "");
  assert.ok(ex.flags.some((f) => f.code === "no_date"));
  // "Shell" is a known fuel vendor → categorize recovers a sensible category.
  assert.equal(ex.category.value, "Fuel");
});

test("a missing total is an error and forces review", () => {
  const ex = visionToExtraction({
    vendor: "Corner Store",
    date: "2026-01-02",
    amount: 0,
    tax: 0,
    currency: "EUR",
    category: "Other",
  });
  assert.ok(ex.amount.value <= 0);
  assert.ok(ex.flags.some((f) => f.code === "no_amount" && f.severity === "error"));
  assert.ok(ex.confidence < 0.8);
});

test("parseVisionJson tolerates code fences and surrounding prose", () => {
  const text = 'Sure!\n```json\n{ "vendor": "X", "amount": 1.5 }\n```\nHope that helps.';
  const parsed = parseVisionJson(text);
  assert.ok(parsed);
  assert.equal(parsed!.vendor, "X");
  assert.equal(parsed!.amount, 1.5);
});

test("parseVisionJson returns null on junk", () => {
  assert.equal(parseVisionJson("no json here"), null);
});

test("OpenRouter free routing is detected for the router and :free models", () => {
  assert.equal(usesFreeRouting("openrouter/free"), true);
  assert.equal(usesFreeRouting("qwen/qwen2.5-vl-72b-instruct:free"), true);
  assert.equal(usesFreeRouting("anthropic/claude-haiku-4.5"), false);
  assert.equal(usesFreeRouting("google/gemini-2.5-flash"), false);
});

test("the built-in free key backs only the OpenRouter free router", () => {
  const cfg = (over: Partial<VisionConfig>): VisionConfig => ({
    enabled: true,
    provider: "openrouter",
    model: "openrouter/free",
    apiKey: "",
    baseUrl: "",
    spendCapUsd: 1,
    spentUsd: 0,
    ...over,
  });
  const BUILT_IN = "sk-built-in"; // injected; production value comes from the build env
  // Free router, no user key → built-in key.
  assert.equal(effectiveApiKey(cfg({}), BUILT_IN), BUILT_IN);
  // A user's own key always wins.
  assert.equal(effectiveApiKey(cfg({ apiKey: "sk-mine" }), BUILT_IN), "sk-mine");
  // A paid OpenRouter model never uses the built-in key.
  assert.equal(effectiveApiKey(cfg({ model: "anthropic/claude-haiku-4.5" }), BUILT_IN), "");
  // Other providers never use the built-in key.
  assert.equal(effectiveApiKey(cfg({ provider: "anthropic", model: "claude-haiku-4-5" }), BUILT_IN), "");
  // A keyless build (this test env) injects nothing and uses no built-in key.
  assert.equal(effectiveApiKey(cfg({})), "");
  assert.equal(hasBuiltInOpenRouterKey(), false);
});
