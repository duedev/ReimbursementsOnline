# Reimbursements Online

Turn a pile of receipts into a polished, submittable reimbursement spreadsheet —
**in your browser, for free.** No install, no accounts, no server, and no receipt
data ever leaves your device.

Snap or drop receipts → they're read on-device with open-source OCR + rules →
review the flagged ones in a keyboard-driven sweep → download a themed,
multi-sheet Excel workbook with the receipt images attached and totals that foot.

This is a from-scratch build of the app described in
[`DESIGN_FROM_SCRATCH.md`](./DESIGN_FROM_SCRATCH.md), whose three fixed goals are:

1. **A correct, polished spreadsheet** — the thing you actually hand in.
2. **Near-zero friction** — open a link, add receipts, get the file.
3. **Near-zero cost** — `$0` idle, `$0` marginal on the default path.

## How it meets the design

The design describes a system as a set of **roles**, each filled by "whatever is
cheapest and easiest for that role" and kept swappable. The cheapest possible
realization of *every* role is the browser itself, so this build collapses them
all client-side — exactly the `$0`-marginal path §5 calls out ("OCR can run on
the user's device… marginal cost literally $0"):

| Role (design §4) | This build |
|---|---|
| Client / capture / review | Installable PWA, mobile camera capture, offline |
| File store | IndexedDB blob store (originals + cleaned images) |
| Work list + Worker | In-browser job queue + Tesseract's own Web Worker |
| Extraction capability | Tesseract.js OCR + deterministic rules, behind one interface — with [opt-in PaddleOCR and vision-LLM tiers](#optional-accuracy-tiers-opt-in) swappable behind the same seam |
| Results store (= board + export source) | IndexedDB |
| Export | ExcelJS themed multi-sheet workbook, built in the browser |

The seams are kept clean (`OcrEngine` interface, repository, job queue) so a real
backend or a paid extraction tier could drop in **without touching the product** —
the design's "keep the smart parts swappable" principle.

### The extraction pipeline (§5, §14) — free and deterministic

1. **Clean** the image on a `<canvas>`: auto-rotate (EXIF), grayscale,
   auto-crop the background, downscale. Improves OCR and shrinks everything.
2. **Read** text with Tesseract.js (open-source, runs on-device, `$0`).
3. **Extract** fields with rules: amount/date/vendor/tax/currency via regex +
   heuristics, a curated **known-vendor database** that names the *brand* (not the
   store address) and classifies it in one pass, **amount reconciliation**
   against the printed total, **confidence scoring**, **duplicate detection** by
   image hash. Re-uploads are free (results cached by hash).

   The vendor DB and its **word-boundary matcher** (a numeric guard so a price
   ending in `.76` or a store `#76` can't read as a fuel brand, and so `inn`/`ink`
   can't fire inside `dinner`/`drink`) are adapted from the original local app's
   hard-won `vendor_db.py` — the lesson being that the naive "first text line"
   heuristic kept grabbing the address instead of the merchant name.

A paid model is **not required** — the default path is `$0`, offline, and
private. Two **opt-in accuracy tiers** sit behind the same `OcrEngine` seam for
people who want them; see [Optional accuracy tiers](#optional-accuracy-tiers-opt-in).

### The output (§3 "the output is the point")

`Generate` builds a themed `.xlsx`:
- **Summary** sheet: employee/job meta, the **expense period** (date range), a
  per-category breakdown, a grand total that foots (real `SUM` formulas), and an
  honest **"Extraction cost: $0.00 — processed free, on your device."** line.
- **Insights** sheet (adapted from the original app's `_compute_stats`):
  headline KPIs — total, **average per receipt**, **largest expense**, flagged
  count — plus **top vendors** and a **day-by-day** spend breakdown.
- **All Receipts** + one sheet **per category**, each with the receipt image
  embedded, zebra striping, a confidence data-bar, large-amount highlighting,
  autofilters, and footing totals. Items still needing review are highlighted.

There's also a one-click **CSV export** (a lightweight, importable companion to
the workbook, adapted from the original's `_results_to_csv`).

### Trust & hardening (§8, §11)

Board + review modal with on-image field markers and per-field **zoomed
callouts**, plus a keyboard **Approve & Next** sweep. Input hardening throughout:
basename-only filenames, type/size/count caps, and non-finite amounts rejected
before they can poison a total.

**Duplicate detection** runs two ways (the second adapted from the original's
`_detect_duplicates`): an exact image-hash match catches a byte-identical
re-upload, and a **semantic** match on vendor + date + amount catches the same
receipt photographed twice. **Total detection** ignores tender/change/cash/
savings/discount/item-count lines so they can't masquerade as the grand total or
trip the reconcile check.

## Run it

```bash
npm install        # also vendors Tesseract assets + OCR language data (one-time)
npm run dev        # http://localhost:5173
npm run build      # static site → dist/  (deploy anywhere: GitHub Pages, Netlify…)
npm run preview    # serve the production build locally
```

There is nothing to host beyond static files, and no runtime cost. Deploy `dist/`
to any static host's free tier.

## Optional accuracy tiers (opt-in)

The default build reads every receipt on-device with Tesseract for `$0` and ships
nothing off your device. Both tiers below are **off by default** and drop in
behind the existing `OcrEngine` seam — nothing downstream (rules, dedup, review,
export) changes.

### Tier 1 — PaddleOCR on-device (still `$0`, offline, private)

A stronger on-device OCR engine: **PaddleOCR PP-OCRv5** (separate detection +
recognition models) running in the browser via **onnxruntime-web** (WebGPU when
available, WASM otherwise). It's materially better than Tesseract on *photographed*
receipts — skew, curl, low contrast, thermal-print fade — while keeping every
guarantee of the default path. It returns the same text + word boxes + confidence,
so field extraction and the on-image markers work unchanged.

```bash
npm install onnxruntime-web      # one-time; not bundled by default
npm run vendor:paddle            # vendors the runtime + PP-OCRv5 models into public/vendor/paddle
VITE_OCR_ENGINE=paddle npm run dev      # or: VITE_OCR_ENGINE=paddle npm run build
```

The runtime and the (~few-MB mobile) models are served same-origin and cached by
the service worker, so it stays offline-capable after first load. Model URLs are
overridable (`PADDLE_DET_URL` / `PADDLE_REC_URL` / `PADDLE_DICT_URL`) or you can
drop `det.onnx` / `rec.onnx` / `dict.txt` into `public/vendor/paddle/models`
yourself.

### Tier 2 — Vision-LLM fallback (paid/free APIs; **leaves your device**)

A confidence-triggered second opinion: for the receipts the on-device pass is
*unsure* about, a vision model re-reads the cleaned image and returns
`{vendor, date, amount, tax, currency, category}` in one shot — collapsing OCR +
rules + categorization. ⚠️ **This sends those receipt images to a third-party API**,
a deliberate departure from the default "nothing leaves your device" promise — so
it's capped by a spend limit and, by default, **off** until you enable it in
**⚙ Settings** (this app has no server, so a key you paste there lives only in
your browser). Configure it under Settings → *paid accuracy tier*:

| Provider | Default model | Cost | Notes |
|---|---|---|---|
| **OpenRouter** (default) | `openrouter/free` (Free Models Router) | **Free** (~50 req/day; 1000/day with ≥10 credits) | Auto-picks a quick, reliable free model that supports vision (`provider.sort: throughput`). One OpenAI-compatible key; type a paid Claude/Gemini id to use those instead. |
| **Google Gemini** | `gemini-2.5-flash` | **Free tier** (no card) | Native vision + structured output. |
| **Anthropic (Claude)** | `claude-haiku-4-5` | ~a fraction of a cent / receipt | Highest accuracy on hard/degraded receipts. |

**Zero-click free tier (build-time key).** Instead of pasting a key per browser,
you can bake an OpenRouter free key into *your* deployment's bundle — it's
injected at build time and **never committed to source** (`dist/` is gitignored):

```bash
OPENROUTER_API_KEY=sk-or-… npm run build   # or VITE_OPENROUTER_FREE_KEY=…
```

With a key baked in, the first run **auto-enables the OpenRouter free router** —
no settings trip needed. ⚠️ This means low-confidence receipts are sent to the
free router by default on that build; **omit the variable to keep everything
on-device.** A user's own key (Settings) always overrides the built-in one, and
the built-in key is only ever used for the *free* router (never paid models).

Only low-confidence receipts trigger a call; each receipt records the method and
cost, so the workbook's **"Extraction cost"** line stays honest (`$0.00` until a
paid call actually happens). To keep the key off the device entirely, point
**Proxy URL** at a thin proxy that injects it server-side.

### Tests

```bash
npm test           # unit tests: money parsing, field extraction, workbook export
node tests/e2e.mjs # full browser e2e: OCR → board → review → xlsx (needs a Chromium)
```

## Notes on cost & offline

- **OCR language data** (`eng.traineddata`, ~11 MB) is vendored at build time and
  served same-origin, so OCR works fully offline at `$0` with no third-party CDN.
  Build with `VITE_TESSDATA_LOCAL=0` to fetch it from the public CDN instead.
- After the first visit the service worker caches the app shell, the OCR core,
  and the language data, so the app runs with no network at all.

## Tech

Vanilla TypeScript + Vite (one language, static output, no framework). Tesseract.js
(OCR), ExcelJS (workbook), pdf.js (PDF input), idb (IndexedDB), vite-plugin-pwa.
Every dependency is open-source and runs client-side. See `DESIGN_FROM_SCRATCH.md`
for the full rationale; technology choices here are means to the design's ends and
are deliberately swappable.
