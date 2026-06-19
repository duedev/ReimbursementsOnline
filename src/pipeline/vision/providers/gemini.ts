import type { VisionProvider } from "../types.ts";
import {
  geminiSchema,
  SYSTEM_PROMPT,
  userInstruction,
  parseVisionJson,
} from "../schema.ts";
import { blobToBase64, errorBody, type ProviderInit } from "./shared.ts";

// Google Gemini — a no-card free tier (e.g. gemini-2.5-flash), native vision,
// and structured output via responseSchema. Browser CORS is supported; the key
// goes in the query string. Free-tier calls report $0 cost.

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export function createGeminiProvider(init: ProviderInit): VisionProvider {
  return {
    id: "gemini",
    async extract(image, ctx) {
      const { base64, mediaType } = await blobToBase64(image);
      const baseUrl = init.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
      const url = `${baseUrl}/models/${init.model}:generateContent?key=${encodeURIComponent(init.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: userInstruction(ctx.currencyDefault) },
                { inline_data: { mime_type: mediaType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: geminiSchema(),
          },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await errorBody(res)}`);
      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      const fields = parseVisionJson(text);
      if (!fields) throw new Error("Gemini returned no parseable JSON.");
      // Free tier → $0. Paid usage would be priced from usageMetadata; left at 0
      // because the free tier is the intended path here.
      return { fields, rawText: text, costUsd: 0, model: init.model };
    },
  };
}
