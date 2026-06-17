import { el } from "./dom.ts";

// Tiny transient notifications. Used for "this cost you $0.00", upload refusals
// (§11), and success messages.

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host) {
    host = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  return host;
}

export type ToastKind = "info" | "success" | "warn" | "error";

export function toast(message: string, kind: ToastKind = "info", ms = 3200): void {
  const node = el("div", { class: `toast toast-${kind}` }, [message]);
  ensureHost().append(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 250);
  }, ms);
}
