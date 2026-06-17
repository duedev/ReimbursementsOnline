// Drives the real app to capture screenshots of the board and the review modal
// (markers + zoomed callouts). Output: tmp/board.png, tmp/review.png
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5181;
const BASE = `http://localhost:${PORT}/`;
const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const outDir = join(root, "tmp");

function receiptSvg(title, rows, total, date) {
  const lines = rows
    .map((r, i) => `<text x="60" y="${250 + i * 46}">${r}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="820">
    <rect width="640" height="820" fill="#ffffff"/>
    <g font-family="monospace" font-size="29" fill="#111111">
      <text x="60" y="84" font-size="36" font-weight="bold">${title}</text>
      <text x="60" y="150">Date: ${date}</text>
      ${lines}
      <text x="60" y="${250 + rows.length * 46 + 24}" font-size="33" font-weight="bold">TOTAL          ${total}</text>
    </g>
  </svg>`;
}

const RECEIPTS = [
  {
    name: "coffee.png",
    svg: receiptSvg("BLUE BOTTLE COFFEE", ["Latte           4.50", "Croissant       3.75", "Sales Tax       0.74"], "8.99", "03/14/2026"),
  },
  {
    name: "hotel.png",
    svg: receiptSvg("MARRIOTT HOTEL", ["Room 1 night  210.00", "City Tax       18.90", "Resort Fee     16.70"], "245.60", "03/12/2026"),
  },
  {
    name: "uber.png",
    svg: receiptSvg("UBER TRIP", ["Trip fare      19.40", "Booking fee     2.50", "Tip             1.50"], "23.40", "03/13/2026"),
  },
  {
    name: "fuel.png",
    svg: receiptSvg("SHELL GAS STATION", ["Unleaded 12gal 48.20", "State Tax       3.90"], "52.10", "03/11/2026"),
  },
];

async function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not start");
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: root,
    stdio: "ignore",
  });
  let browser;
  try {
    await waitForServer(BASE);
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 920 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(BASE, { waitUntil: "load" });

    await page.getByText("Receipts → a polished report").waitFor({ timeout: 15000 });
    await page.locator("input[autocomplete=name]").fill("Ada Lovelace");
    await page.locator(".field-row input").first().fill("Q1 Client Visit");
    await page.getByRole("button", { name: /Start a new report/ }).click();
    await page.getByText("Drop receipts here").waitFor({ timeout: 10000 });

    for (const r of RECEIPTS) {
      await page.locator("input[type=file][multiple]").setInputFiles({
        name: r.name,
        mimeType: "image/png",
        buffer: await sharp(Buffer.from(r.svg)).png().toBuffer(),
      });
    }

    // wait until all four are processed (each shows an amount)
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll(".rcard .amount")];
        return cards.length === 4 && cards.every((c) => /\d/.test(c.textContent || ""));
      },
      { timeout: 180000 },
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, "board.png") });
    console.log("saved board.png");

    // open review on the first card and wait for the receipt image + markers
    await page.locator(".rcard").first().click();
    await page.locator(".modal .review-image img").waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelector(".overlay .marker"), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.locator(".modal").screenshot({ path: join(outDir, "review.png") });
    console.log("saved review.png");
  } finally {
    if (browser) await browser.close();
    server.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
