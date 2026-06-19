import { el, mount } from "../dom.ts";
import { repo } from "../../store/repo.ts";
import { CATEGORIES } from "../../config/categories.ts";
import { parseAmount, safeAmount, formatMoney } from "../../util/money.ts";
import { isValidIso } from "../../util/format.ts";
import { toast } from "../toast.ts";
import type { Receipt, BBox, Category } from "../../types.ts";

// The review sweep (§8, §14): the same board → modal → keyboard *Approve & Next*
// flow the design calls a genuine strength. On-image markers and per-field
// zoomed callouts show each extracted value beside the slice of the receipt it
// came from, so a human can confirm 30 receipts in a minute of tapping.

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "INR", "MXN", "CNY"];

export class ReviewModal {
  private receipts: Receipt[];
  private index: number;
  private onClose: () => void;
  private scrim: HTMLElement | null = null;
  private imageUrl: string | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(receipts: Receipt[], index: number, onClose: () => void) {
    this.receipts = receipts;
    this.index = index;
    this.onClose = onClose;
  }

  get current(): Receipt | undefined {
    return this.receipts[this.index];
  }

  open(): void {
    this.scrim = el("div", {
      class: "scrim",
      onclick: (e: Event) => {
        if (e.target === this.scrim) this.close();
      },
    });
    document.body.append(this.scrim);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", this.keyHandler);
    this.render();
  }

  close(): void {
    window.removeEventListener("keydown", this.keyHandler);
    this.revokeImage();
    this.scrim?.remove();
    this.scrim = null;
    document.body.style.overflow = "";
    this.onClose();
  }

  /** Called when the repo changes; keep nav list fresh without stealing focus. */
  update(receipts: Receipt[]): void {
    const currentId = this.current?.id;
    this.receipts = receipts;
    if (currentId) {
      const i = receipts.findIndex((r) => r.id === currentId);
      if (i >= 0) this.index = i;
    }
  }

  private revokeImage(): void {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = null;
    }
  }

  private go(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.receipts.length) return;
    this.index = next;
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
      this.close();
      return;
    }
    // Approve & Next works even while typing (Enter), for a fast sweep.
    if (e.key === "Enter") {
      e.preventDefault();
      void this.approveAndNext();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "n") this.go(1);
    else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "p") this.go(-1);
    else if (e.key.toLowerCase() === "a") void this.approveAndNext();
  }

  // ---- save / approve ---------------------------------------------------

  private readForm(): Partial<Receipt> | null {
    const root = this.scrim;
    if (!root) return null;
    const get = (sel: string) => root.querySelector<HTMLInputElement>(sel);
    const vendor = get("[data-f=vendor]")?.value.trim() ?? "";
    const dateRaw = get("[data-f=date]")?.value ?? "";
    const amount = parseAmount(get("[data-f=amount]")?.value ?? "");
    const tax = parseAmount(get("[data-f=tax]")?.value ?? "");
    const currency = (root.querySelector<HTMLSelectElement>("[data-f=currency]")?.value ?? "USD").toUpperCase();
    const category = (root.querySelector<HTMLSelectElement>("[data-f=category]")?.value ?? "Other") as Category;
    const cur = this.current;
    if (!cur) return null;

    const date = dateRaw && isValidIso(dateRaw) ? dateRaw : cur.date.value;
    return {
      vendor: { value: vendor, confidence: 1, edited: true, ...(cur.vendor.bbox ? { bbox: cur.vendor.bbox } : {}) },
      date: { value: date, confidence: 1, edited: true, ...(cur.date.bbox ? { bbox: cur.date.bbox } : {}) },
      amount: {
        value: amount !== null ? safeAmount(amount) : cur.amount.value,
        confidence: 1,
        edited: true,
        ...(cur.amount.bbox ? { bbox: cur.amount.bbox } : {}),
      },
      tax: { value: tax !== null ? safeAmount(tax) : cur.tax.value, confidence: 1, edited: true },
      currency,
      category: { value: category, confidence: 1, edited: true },
    };
  }

  private async save(silent = false): Promise<Receipt | undefined> {
    const cur = this.current;
    const patch = this.readForm();
    if (!cur || !patch) return undefined;
    const updated = await repo.updateReceipt(cur.id, patch);
    if (updated) {
      this.receipts[this.index] = updated;
      if (!silent) toast("Saved.", "success", 1200);
    }
    return updated;
  }

  private async approveAndNext(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const patch = this.readForm() ?? {};
    const flags = cur.flags.filter((f) => f.severity === "error" && f.code === "no_amount");
    const amountOk = (patch.amount?.value ?? cur.amount.value) > 0;
    const updated = await repo.updateReceipt(cur.id, {
      ...patch,
      approved: true,
      reviewRequired: false,
      status: "done",
      flags: amountOk ? [] : flags,
    });
    if (updated) this.receipts[this.index] = updated;

    // Advance to the next receipt that still wants a look; else just next; else close.
    const nextFlagged = this.receipts.findIndex(
      (r, i) => i > this.index && r.reviewRequired && !r.approved,
    );
    if (nextFlagged >= 0) {
      this.index = nextFlagged;
      this.render();
    } else if (this.index < this.receipts.length - 1) {
      this.index += 1;
      this.render();
    } else {
      toast("All caught up — every receipt reviewed.", "success");
      this.close();
    }
  }

  // ---- render -----------------------------------------------------------

  private render(): void {
    const r = this.current;
    if (!r || !this.scrim) return;
    this.revokeImage();

    const head = el("div", { class: "modal-head" }, [
      el("strong", {}, [`Review receipt`]),
      el("span", { class: "count" }, [`${this.index + 1} of ${this.receipts.length}`]),
      el("div", { class: "appbar-spacer", style: "flex:1" }),
      el("button", { class: "btn btn-soft", onclick: () => this.close() }, ["Close"]),
    ]);

    const imgWrap = el("div", { class: "imgwrap" });
    const overlay = el("div", { class: "overlay" });
    const imgEl = el("img", { alt: r.fileName }) as HTMLImageElement;
    imgWrap.append(imgEl, overlay);
    const imageCol = el("div", { class: "review-image" }, [imgWrap]);

    const form = this.renderForm(r);
    const body = el("div", { class: "modal-body" }, [imageCol, form]);

    const foot = el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-soft", onclick: () => this.go(-1) }, ["← Prev"]),
      el("button", { class: "btn btn-soft", onclick: () => this.go(1) }, ["Next →"]),
      el("button", { class: "btn btn-danger", onclick: () => void this.deleteCurrent() }, ["Delete"]),
      el("div", { class: "spacer" }),
      el("span", { class: "kbd" }, ["Enter"]),
      el("button", { class: "btn btn-accent btn-lg", onclick: () => void this.approveAndNext() }, [
        "Approve & Next",
      ]),
    ]);

    const modal = el("div", { class: "modal" }, [head, body, foot]);
    mount(this.scrim, modal);

    // Load the cleaned image, then draw markers + callouts from stored bboxes.
    const key = r.cleanedKey ?? r.fileKey;
    void repo.getBlob(key).then((blob) => {
      if (!blob) return;
      this.imageUrl = URL.createObjectURL(blob);
      imgEl.src = this.imageUrl;
      imgEl.onload = () => {
        this.drawMarkers(overlay, r);
        this.drawCallouts(form, imgEl, r);
      };
    });
  }

  private renderForm(r: Receipt): HTMLElement {
    const field = (label: string, control: HTMLElement, fieldName?: string): HTMLElement => {
      const row = el("div", { class: "frow" }, [el("label", {}, [label]), control]);
      if (fieldName) row.dataset.callout = fieldName;
      return row;
    };

    const vendor = input("text", r.vendor.value, "vendor");
    const date = input("date", r.date.value, "date");
    const amount = input("number", r.amount.value ? String(r.amount.value) : "", "amount");
    amount.step = "0.01";
    const tax = input("number", r.tax.value ? String(r.tax.value) : "", "tax");
    tax.step = "0.01";

    const currency = el(
      "select",
      { "data-f": "currency" },
      uniq([r.currency, ...CURRENCIES]).map((c) =>
        el("option", { value: c, ...(c === r.currency ? { selected: true } : {}) }, [c]),
      ),
    ) as HTMLSelectElement;

    const category = el(
      "select",
      { "data-f": "category" },
      CATEGORIES.map((c) =>
        el("option", { value: c, ...(c === r.category.value ? { selected: true } : {}) }, [c]),
      ),
    ) as HTMLSelectElement;

    const autosave = () => void this.save(true);
    for (const ctrl of [vendor, date, amount, tax]) ctrl.addEventListener("change", autosave);
    currency.addEventListener("change", autosave);
    category.addEventListener("change", autosave);

    const flags = r.flags.length
      ? el(
          "div",
          { class: "flags" },
          r.flags.map((f) =>
            el("div", { class: `flag ${f.severity}` }, [
              el("span", {}, [f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "ℹ️"]),
              el("span", {}, [f.message]),
            ]),
          ),
        )
      : null;

    return el("div", { class: "review-form" }, [
      field("Vendor", vendor, "vendor"),
      field("Date", date, "date"),
      el("div", { class: "frow" }, [
        el("label", {}, ["Amount"]),
        el("div", { class: "amount-grid" }, [amount, currency]),
      ]),
      el("div", { class: "frow", "data-callout": "amount" }, []),
      field("Tax", tax),
      field("Category", category),
      flags,
      el("p", { class: "cap", style: "color:var(--slate);font-size:12px;margin-top:8px" }, [
        `${r.methodUsed === "paid" ? `Read by ${r.methodDetail ?? "paid model"}` : "Read on-device"} · ` +
          `${Math.round(r.confidence * 100)}% confidence · ${formatMoney(r.cost)}`,
      ]),
    ]);
  }

  private drawMarkers(overlay: HTMLElement, r: Receipt): void {
    mount(overlay);
    const add = (bbox: BBox | undefined, cls: string, label: string) => {
      if (!bbox || bbox.w <= 0 || bbox.h <= 0) return;
      const m = el("div", { class: `marker ${cls}` }, [el("span", {}, [label])]);
      m.style.left = `${bbox.x * 100}%`;
      m.style.top = `${bbox.y * 100}%`;
      m.style.width = `${bbox.w * 100}%`;
      m.style.height = `${bbox.h * 100}%`;
      overlay.append(m);
    };
    add(r.vendor.bbox, "vendor", "Vendor");
    add(r.date.bbox, "date", "Date");
    add(r.amount.bbox, "amount", "Total");
  }

  private drawCallouts(form: HTMLElement, img: HTMLImageElement, r: Receipt): void {
    const specs: [string, BBox | undefined][] = [
      ["vendor", r.vendor.bbox],
      ["date", r.date.bbox],
      ["amount", r.amount.bbox],
    ];
    for (const [name, bbox] of specs) {
      const row = form.querySelector<HTMLElement>(`[data-callout=${name}]`);
      if (!row || !bbox || bbox.w <= 0 || bbox.h <= 0) continue;
      const canvas = this.cropCanvas(img, bbox);
      if (!canvas) continue;
      const callout = el("div", { class: "callout" }, [
        canvas,
        el("span", { class: "cap" }, ["read from the receipt"]),
      ]);
      row.after(callout);
    }
  }

  private cropCanvas(img: HTMLImageElement, bbox: BBox): HTMLCanvasElement | null {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return null;
    // Pad the crop a little for context.
    const padX = bbox.w * 0.12;
    const padY = bbox.h * 0.5;
    const sx = Math.max(0, (bbox.x - padX) * iw);
    const sy = Math.max(0, (bbox.y - padY) * ih);
    const sw = Math.min(iw - sx, (bbox.w + padX * 2) * iw);
    const sh = Math.min(ih - sy, (bbox.h + padY * 2) * ih);
    if (sw <= 0 || sh <= 0) return null;
    const maxW = 200;
    const maxH = 64;
    const scale = Math.min(maxW / sw, maxH / sh, 4);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private async deleteCurrent(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    if (!confirm(`Delete "${cur.vendor.value || cur.fileName}"?`)) return;
    await repo.deleteReceipt(cur.id);
    this.receipts.splice(this.index, 1);
    if (this.receipts.length === 0) {
      this.close();
      return;
    }
    if (this.index >= this.receipts.length) this.index = this.receipts.length - 1;
    this.render();
  }
}

function input(type: string, value: string, fieldName: string): HTMLInputElement {
  return el("input", { type, value, "data-f": fieldName }) as HTMLInputElement;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}
