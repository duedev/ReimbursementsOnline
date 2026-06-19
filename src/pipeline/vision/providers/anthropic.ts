import type { VisionProvider } from "../types.ts";
import {
  RECEIPT_JSON_SCHEMA,
  SYSTEM_PROMPT,
  userInstruction,
  parseVisionJson,
} from "../schema.ts";
import { blobToBase64, errorBody, type ProviderInit } from "./shared.ts";

// Anthropic Claude — vision + structured outputs in one call. Browser calls
// require the explicit opt-in header below plus a user-supplied key. Default
// model is Claude Haiku 4.5: cheap, fast, vision-capable — a fraction of a cent
// per receipt, which is the whole point of a confidence-triggered paid tier.

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

// $/1M tokens (input, output). Keyed by model id; unknown models report $0
// rather than guess.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
};

export function createAnthropicProvider(init: ProviderInit): VisionProvider {
  return {
    id: "anthropic",
    async extract(image, ctx) {
      const { base64, mediaType } = await blobToBase64(image);
      const url = `${init.baseUrl || "https://api.anthropic.com"}/v1/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": init.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: init.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userInstruction(ctx.currencyDefault) },
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              ],
            },
          ],
          output_config: { format: { type: "json_schema", schema: RECEIPT_JSON_SCHEMA } },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await errorBody(res)}`);
      const data = (await res.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const fields = parseVisionJson(text);
      if (!fields) throw new Error("Anthropic returned no parseable JSON.");
      return {
        fields,
        rawText: text,
        costUsd: priceCall(init.model, data.usage),
        model: init.model,
      };
    },
  };
}

function priceCall(model: string, usage: AnthropicResponse["usage"]): number {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
