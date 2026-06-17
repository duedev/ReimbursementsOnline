// End-to-end smoke test against the real production build, driven through a
// headless Chromium. Proves the browser-only paths the unit tests can't:
// IndexedDB storage, canvas image-prep, on-device Tesseract OCR, the board/
// review UI, and xlsx export. Run with: node tests/e2e.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import ExcelJS from "exceljs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5179;
const BASE = `http://localhost:${PORT}/`;
const CHROME =
  process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const log = (...a) => console.log("•", ...a);
let failures = 0;
function check(cond, msg) {
  if (cond) log("PASS:", msg);
  else {
    failures++;
    console.error("FAIL:", msg);
  }
}

async function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("preview server did not start");
}

async function makeReceiptPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="820">
    <rect width="640" height="820" fill="#ffffff"/>
    <g font-family="monospace" font-size="30" fill="#000000">
      <text x="60" y="80" font-size="38" font-weight="bold">BLUE BOTTLE COFFEE</text>
      <text x="60" y="130">123 Main Street</text>
      <text x="60" y="175">Date: 03/14/2026</text>
      <text x="60" y="260">Latte               4.50</text>
      <text x="60" y="305">Croissant           3.75</text>
      <text x="60" y="370">Subtotal            8.25</text>
      <text x="60" y="415">Sales Tax           0.74</text>
      <text x="60" y="475" font-size="34" font-weight="bold">TOTAL               8.99</text>
      <text x="60" y="560">Thank you!</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  log("starting preview server…");
  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  let browser;
  try {
    await waitForServer(BASE);
    log("server up");

    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.error("  [page error]", m.text());
    });
    page.on("dialog", (d) => d.accept()); // auto-accept confirms

    await page.goto(BASE, { waitUntil: "load" });

    // 1. Setup screen → create a batch.
    await page.getByText("Receipts → a polished report").waitFor({ timeout: 15000 });
    check(true, "setup screen rendered");
    await page.locator("input[autocomplete=name]").fill("Ada Lovelace");
    await page.locator(".field-row input").first().fill("Q1 Coffee Run");
    await page.getByRole("button", { name: /Start a new report/ }).click();

    // 2. Board appears.
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });
    check(true, "board rendered after creating batch");

    // 3. Upload a synthetic receipt and let on-device OCR run.
    log("uploading synthetic receipt, running OCR (first run downloads nothing — all local)…");
    await page.locator("input[type=file][multiple]").setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: await makeReceiptPng(),
    });

    // 4. Wait for the card to show a parsed amount.
    const amount = page.locator(".rcard .amount").first();
    await amount.waitFor({ timeout: 120000 });
    await page.waitForFunction(
      () => {
        const e = document.querySelector(".rcard .amount");
        return e && /\d/.test(e.textContent || "");
      },
      { timeout: 120000 },
    );
    const amountText = (await amount.textContent())?.trim();
    const vendorText = (await page.locator(".rcard .vendor").first().textContent())?.trim();
    log(`extracted → vendor="${vendorText}" amount="${amountText}"`);
    check(/8\.99/.test(amountText || ""), `OCR+rules read the total (got ${amountText})`);
    check(/BLUE|BOTTLE|COFFEE/i.test(vendorText || ""), `OCR+rules read the vendor (got ${vendorText})`);

    // 5. Verify the receipt persisted in IndexedDB with category + cost.
    const dbInfo = await page.evaluate(async () => {
      const open = indexedDB.open("reimbursements-online");
      const db = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const tx = db.transaction("receipts", "readonly");
      const all = await new Promise((res) => {
        const req = tx.objectStore("receipts").getAll();
        req.onsuccess = () => res(req.result);
      });
      return all.map((r) => ({ cat: r.category.value, cost: r.cost, method: r.methodUsed }));
    });
    check(dbInfo.length === 1, "one receipt stored in IndexedDB");
    check(dbInfo[0]?.cost === 0 && dbInfo[0]?.method === "rules", "recorded as free (rules, $0)");
    check(dbInfo[0]?.cat === "Meals & Entertainment", `categorized (got ${dbInfo[0]?.cat})`);

    // 6. Generate the spreadsheet and validate the downloaded workbook.
    const dlDir = await mkdtemp(join(tmpdir(), "reimb-"));
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.getByRole("button", { name: /Generate/ }).click(),
    ]);
    const xlsxPath = join(dlDir, download.suggestedFilename());
    await download.saveAs(xlsxPath);
    log("downloaded", download.suggestedFilename());

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const names = wb.worksheets.map((w) => w.name);
    check(names.includes("Summary"), "workbook has Summary sheet");
    check(names.includes("All Receipts"), "workbook has All Receipts sheet");
    check(
      names.includes("Meals & Entertainment"),
      `workbook has the category sheet (sheets: ${names.join(", ")})`,
    );
  } finally {
    if (browser) await browser.close();
    server.kill("SIGKILL");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll end-to-end checks passed ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
