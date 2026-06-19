import type { VisionProvider } from "../types.ts";
import {
  RECEIPT_JSON_SCHEMA,
  SYSTEM_PROMPT,
  userInstruction,
  parseVisionJson,
} from "../schema.ts";
import { blobToBase64, dataUrl, appOrigin, errorBody, type ProviderInit } from "./shared.ts";

// OpenRouter — one OpenAI-compatible endpoint and one key that unlocks free
// vision models (the `:free` suffix, e.g. qwen/qwen2.5-vl-72b-instruct:free)
// *and* paid Claude/Gemini. Browser CORS is supported. Cost is read from the
// usage block (0 for free models).

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { cost?: number };
}

export function createOpenRouterProvider(init: ProviderInit): VisionProvider {
  return {
    id: "openrouter",
    async extract(image, ctx) {
      const { base64, mediaType } = await blobToBase64(image);
      const url = `${init.baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${init.apiKey}`,
          "HTTP-Referer": appOrigin(),
          "X-Title": "Reimbursements Online",
        },
        body: JSON.stringify({
          model: init.model,
          temperature: 0,
          max_tokens: 700,
          usage: { include: true },
          response_format: {
            type: "json_schema",
            json_schema: { name: "receipt", strict: true, schema: RECEIPT_JSON_SCHEMA },
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: userInstruction(ctx.currencyDefault) },
                { type: "image_url", image_url: { url: dataUrl(base64, mediaType) } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await errorBody(res)}`);
      const data = (await res.json()) as OpenRouterResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      const fields = parseVisionJson(text);
      if (!fields) throw new Error("OpenRouter returned no parseable JSON.");
      return {
        fields,
        rawText: text,
        costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : 0,
        model: init.model,
      };
    },
  };
}
