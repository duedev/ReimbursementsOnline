import { el, mount } from "../dom.ts";
import { toast } from "../toast.ts";
import { formatMoney } from "../../util/money.ts";
import {
  getVisionConfig,
  saveVisionConfig,
  PROVIDERS,
  type VisionConfig,
} from "../../pipeline/vision/config.ts";
import { testVisionConnection } from "../../pipeline/vision/index.ts";
import type { ProviderId } from "../../pipeline/vision/types.ts";

// Settings for the optional Tier 3 "paid accuracy dial" (DESIGN §5/§9). Off by
// default; lets a user opt into a vision-LLM second opinion for low-confidence
// receipts using their own API key. The privacy trade-off is stated plainly:
// turning this on means those receipt images leave the device.

export class SettingsModal {
  private scrim: HTMLElement | null = null;
  private cfg: VisionConfig = getVisionConfig();
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  open(): void {
    this.cfg = getVisionConfig();
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
    this.scrim?.remove();
    this.scrim = null;
    document.body.style.overflow = "";
  }

  /** Snapshot the form into this.cfg (so a provider switch keeps edits). */
  private readForm(): void {
    const root = this.scrim;
    if (!root) return;
    const v = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
    const enabled = v<HTMLInputElement>("[data-f=enabled]")?.checked ?? false;
    const provider = (v<HTMLSelectElement>("[data-f=provider]")?.value ??
      this.cfg.provider) as ProviderId;
    const model = v<HTMLInputElement>("[data-f=model]")?.value.trim() || PROVIDERS[provider].defaultModel;
    const apiKey = v<HTMLInputElement>("[data-f=apiKey]")?.value.trim() ?? "";
    const baseUrl = v<HTMLInputElement>("[data-f=baseUrl]")?.value.trim() ?? "";
    const capRaw = Number(v<HTMLInputElement>("[data-f=cap]")?.value);
    const spendCapUsd = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : this.cfg.spendCapUsd;
    this.cfg = { ...this.cfg, enabled, provider, model, apiKey, baseUrl, spendCapUsd };
  }

  private onProviderChange(): void {
    this.readForm();
    // Reset the model to the new provider's default for a clean starting point.
    this.cfg.model = PROVIDERS[this.cfg.provider].defaultModel;
    this.render();
  }

  private save(): void {
    this.readForm();
    saveVisionConfig(this.cfg);
    toast(
      this.cfg.enabled
        ? "Saved. Paid fallback is ON for low-confidence receipts."
        : "Saved. Paid fallback is off — everything stays on-device.",
      "success",
    );
    this.close();
  }

  private async test(): Promise<void> {
    this.readForm();
    toast("Testing connection…", "info", 1500);
    const res = await testVisionConnection(this.cfg);
    toast(res.message, res.ok ? "success" : "error", res.ok ? 3000 : 6000);
  }

  private render(): void {
    if (!this.scrim) return;
    const meta = PROVIDERS[this.cfg.provider];

    const head = el("div", { class: "modal-head" }, [
      el("strong", {}, ["Settings · paid accuracy tier"]),
      el("div", { class: "appbar-spacer", style: "flex:1" }),
      el("button", { class: "btn btn-soft", onclick: () => this.close() }, ["Close"]),
    ]);

    const enabled = el("input", {
      type: "checkbox",
      "data-f": "enabled",
      ...(this.cfg.enabled ? { checked: true } : {}),
    }) as HTMLInputElement;

    const providerSel = el(
      "select",
      { "data-f": "provider", onchange: () => this.onProviderChange() },
      (Object.keys(PROVIDERS) as ProviderId[]).map((id) =>
        el("option", { value: id, ...(id === this.cfg.provider ? { selected: true } : {}) }, [
          PROVIDERS[id].label,
        ]),
      ),
    );

    const modelList = el(
      "datalist",
      { id: "model-suggestions" },
      meta.models.map((m) => el("option", { value: m })),
    );
    const model = el("input", {
      type: "text",
      "data-f": "model",
      list: "model-suggestions",
      value: this.cfg.model,
      placeholder: meta.defaultModel,
    });

    const apiKey = el("input", {
      type: "password",
      "data-f": "apiKey",
      value: this.cfg.apiKey,
      placeholder: "sk-…  (stored only in this browser)",
      autocomplete: "off",
    });

    const baseUrl = el("input", {
      type: "text",
      "data-f": "baseUrl",
      value: this.cfg.baseUrl,
      placeholder: "(optional) proxy base URL to keep your key off the device",
    });

    const cap = el("input", {
      type: "number",
      "data-f": "cap",
      value: String(this.cfg.spendCapUsd),
      step: "0.25",
      min: "0",
    }) as HTMLInputElement;

    const body = el("div", { class: "settings-body" }, [
      el("div", { class: "settings-warn" }, [
        el("strong", {}, ["Heads up — this sends receipt images off your device."]),
        el("span", {}, [
          " The default app reads everything locally for $0. This optional tier asks a " +
            "vision model to re-read only the receipts the on-device pass is unsure about. " +
            "It needs your own API key and uploads those images to the provider you pick.",
        ]),
      ]),

      frow("Enable paid fallback", el("label", { class: "switch" }, [enabled, el("span", {}, [
        this.cfg.enabled ? " On for low-confidence receipts" : " Off (everything stays local)",
      ])])),

      frow("Provider", providerSel),
      el("p", { class: "settings-note" }, [
        meta.note + " ",
        el("a", { href: meta.keyUrl, target: "_blank", rel: "noopener" }, ["Get a key ↗"]),
      ]),

      frow("Model", model),
      modelList,
      frow("API key", apiKey),
      frow("Proxy URL", baseUrl),
      frow("Spend cap (USD)", cap),
      el("p", { class: "settings-note" }, [
        `Spent so far: ${formatMoney(this.cfg.spentUsd)}. ` +
          "Free models / free tiers report $0; the cap blocks paid calls once reached (0 = no cap).",
      ]),
    ]);

    const foot = el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-soft", onclick: () => void this.test() }, ["Test connection"]),
      el("div", { class: "spacer" }),
      el("button", { class: "btn btn-accent btn-lg", onclick: () => this.save() }, ["Save"]),
    ]);

    mount(this.scrim, el("div", { class: "modal settings-modal" }, [head, body, foot]));
  }
}

function frow(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "frow" }, [el("label", {}, [label]), control]);
}
