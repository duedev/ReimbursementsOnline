import { el } from "../dom.ts";
import { repo } from "../../store/repo.ts";
import { CATEGORY_META } from "../../config/categories.ts";
import { formatMoney } from "../../util/money.ts";
import { formatDate } from "../../util/format.ts";
import { LIMITS } from "../../config/constants.ts";
import type { App } from "../app.ts";
import type { Receipt, ReceiptStatus } from "../../types.ts";

// The board *is* the results store, read live (§4). Cards update in place as the
// queue drains. Capture sits up top so "snap → it's in" is the happy path (§3).

// Cache object URLs by blob key so frequent re-renders don't leak/regenerate.
const thumbCache = new Map<string, Promise<string>>();
function thumbUrl(key: string): Promise<string> {
  let p = thumbCache.get(key);
  if (!p) {
    p = repo.getBlob(key).then((b) => (b ? URL.createObjectURL(b) : ""));
    thumbCache.set(key, p);
  }
  return p;
}

const STATUS_ORDER: Record<ReceiptStatus, number> = {
  failed: 0,
  needs_review: 1,
  processing: 2,
  queued: 3,
  done: 4,
};

export function renderBoard(app: App): HTMLElement {
  const receipts = app.getReceipts();
  const total = receipts
    .filter((r) => r.amount.value > 0)
    .reduce((s, r) => s + r.amount.value, 0);
  const needs = receipts.filter((r) => r.reviewRequired && !r.approved).length;
  const currency = receipts[0]?.currency ?? "USD";

  const stats = el("div", { class: "stats" }, [
    stat("Receipts", String(receipts.length)),
    stat("Total", formatMoney(total, currency)),
    stat("To review", String(needs)),
    stat("Cost", "$0.00", true),
  ]);

  const capture = renderCapture(app);

  let body: HTMLElement;
  if (receipts.length === 0) {
    body = el("div", { class: "empty" }, [
      el("p", {}, ["No receipts yet."]),
      el("p", {}, ["Add a photo or PDF above to get started."]),
    ]);
  } else {
    const sorted = [...receipts].sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.createdAt - b.createdAt,
    );
    const grid = el("div", { class: "board" }, sorted.map((r) => card(app, r)));
    const header = el(
      "div",
      { style: "display:flex;align-items:center;gap:10px;margin:18px 0 10px" },
      [
        el("p", { class: "section-title", style: "margin:0;flex:1" }, ["Receipts"]),
        needs > 0
          ? el(
              "button",
              { class: "btn btn-soft", onclick: () => app.reviewFirstFlagged() },
              [`Review ${needs} flagged →`],
            )
          : null,
        el(
          "button",
          { class: "btn btn-danger", onclick: () => void app.deleteBatch() },
          ["Delete batch"],
        ),
      ],
    );
    body = el("div", {}, [header, grid]);
  }

  return el("div", { class: "app-main" }, [stats, capture, body]);
}

function stat(k: string, v: string, green = false): HTMLElement {
  return el("div", { class: "stat" }, [
    el("div", { class: "k" }, [k]),
    el("div", { class: `v ${green ? "green" : ""}` }, [v]),
  ]);
}

function renderCapture(app: App): HTMLElement {
  const fileInput = el("input", {
    type: "file",
    accept: "image/*,application/pdf",
    multiple: true,
    class: "hidden-input",
    onchange: (e) => {
      const t = e.target as HTMLInputElement;
      if (t.files) void app.addFiles(t.files);
      t.value = "";
    },
  }) as HTMLInputElement;

  const cameraInput = el("input", {
    type: "file",
    accept: "image/*",
    capture: "environment",
    class: "hidden-input",
    onchange: (e) => {
      const t = e.target as HTMLInputElement;
      if (t.files) void app.addFiles(t.files);
      t.value = "";
    },
  }) as HTMLInputElement;

  const zone = el(
    "div",
    {
      class: "dropzone",
      ondragover: (e: Event) => {
        e.preventDefault();
        zone.classList.add("drag");
      },
      ondragleave: () => zone.classList.remove("drag"),
      ondrop: (e: Event) => {
        e.preventDefault();
        zone.classList.remove("drag");
        const dt = (e as DragEvent).dataTransfer;
        if (dt?.files?.length) void app.addFiles(dt.files);
      },
    },
    [
      el("div", { class: "big" }, ["Drop receipts here"]),
      el("div", {}, [`Photos or PDF · up to ${LIMITS.maxReceiptsPerBatch} per report`]),
      el("div", { class: "actions" }, [
        el(
          "button",
          { class: "btn btn-accent", onclick: () => cameraInput.click() },
          ["📷 Take photo"],
        ),
        el(
          "button",
          { class: "btn btn-soft", onclick: () => fileInput.click() },
          ["📁 Choose files"],
        ),
      ]),
      fileInput,
      cameraInput,
    ],
  );
  return zone;
}

function card(app: App, r: Receipt): HTMLElement {
  const busy = r.status === "queued" || r.status === "processing";
  const thumb = el("div", { class: "thumb" }, [
    busy ? el("div", { class: "spin" }, [el("div", { class: "spinner" })]) : null,
    el("span", { class: `badge ${r.status}`, style: "position:absolute;top:8px;left:8px" }, [
      statusLabel(r.status),
    ]),
  ]);
  const key = r.cleanedKey ?? r.fileKey;
  void thumbUrl(key).then((url) => {
    if (url) thumb.style.backgroundImage = `url("${url}")`;
  });

  const meta = CATEGORY_META[r.category.value];
  const confColor =
    r.confidence >= 0.8 ? "#16a34a" : r.confidence >= 0.6 ? "#f59e0b" : "#dc2626";

  const flagDots = r.flags
    .slice(0, 4)
    .map((f) =>
      el("span", { class: "flagdot", title: f.message }, [
        f.severity === "error" ? "🔴" : f.severity === "warn" ? "🟠" : "🔵",
      ]),
    );

  const body = el("div", { class: "body" }, [
    el("div", { class: "vendor" }, [r.vendor.value || r.fileName || "Untitled"]),
    el("div", { class: "meta" }, [
      el("span", { class: "amount" }, [
        r.amount.value > 0 ? formatMoney(r.amount.value, r.currency) : "—",
      ]),
      el("span", { class: "date" }, [r.date.value ? formatDate(r.date.value) : "no date"]),
    ]),
    el("div", { class: "row2" }, [
      el("span", { class: "chip cat", style: `background:#${meta.color.slice(2)}` }, [
        `${meta.emoji} ${r.category.value}`,
      ]),
      ...flagDots,
    ]),
    el("div", { class: "confbar" }, [
      el("i", { style: `width:${Math.round(r.confidence * 100)}%;background:${confColor}` }),
    ]),
  ]);

  return el(
    "div",
    {
      class: `rcard ${r.reviewRequired && !r.approved ? "review" : ""} ${r.status === "failed" ? "failed" : ""}`,
      onclick: () => app.openReview(r.id),
    },
    [thumb, body],
  );
}

function statusLabel(s: ReceiptStatus): string {
  return s === "needs_review" ? "review" : s;
}
