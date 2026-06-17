// Export-time image compression (§8). Originals/cleaned images stay sharp for
// OCR; only here, when building the workbook, do we shrink them to keep the
// file small. Runs on a <canvas> in the browser.

export interface Thumb {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  ext: "jpeg";
}

export async function thumbnail(
  blob: Blob,
  maxEdge = 520,
  quality = 0.72,
): Promise<Thumb> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("thumbnail encode failed"))),
      "image/jpeg",
      quality,
    ),
  );
  return { buffer: await out.arrayBuffer(), width: w, height: h, ext: "jpeg" };
}
