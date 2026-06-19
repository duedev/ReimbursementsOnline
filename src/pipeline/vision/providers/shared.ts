// Shared plumbing for the vision providers: image encoding and small fetch
// helpers. The providers are deliberately raw `fetch` calls (not vendor SDKs):
// this is a tiny, opt-in tier in a zero-dependency client PWA, and keeping all
// three providers on one uniform shape avoids bundling multiple SDKs.

export interface ProviderInit {
  apiKey: string;
  model: string;
  /** Optional override — e.g. a self-hosted proxy that holds the real key. */
  baseUrl?: string;
}

/** Encode a Blob as base64 (no data: prefix) plus its media type. */
export async function blobToBase64(
  blob: Blob,
): Promise<{ base64: string; mediaType: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000; // chunk to avoid arg-count limits on fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { base64: btoa(bin), mediaType: blob.type || "image/jpeg" };
}

export function dataUrl(base64: string, mediaType: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/** A referer/title pair OpenRouter likes for attribution; harmless elsewhere. */
export function appOrigin(): string {
  return typeof location !== "undefined" ? location.origin : "https://reimbursements.online";
}

/** Read a response body for an error message without throwing. */
export async function errorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return res.statusText;
  }
}
