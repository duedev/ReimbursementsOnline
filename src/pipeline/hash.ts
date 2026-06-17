// Content hash of the cleaned image bytes. Doubles as the extraction cache key
// (re-uploads/retries are free, §5) and the duplicate-detection key (§14).

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function hashBlob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}
