import { el } from "../dom.ts";
import { APP_NAME } from "../../config/constants.ts";
import type { App } from "../app.ts";

export function renderHeader(app: App): HTMLElement {
  const batch = app.currentBatch;
  const processing = app.remaining > 0;

  const actions: HTMLElement[] = [];
  if (batch) {
    actions.push(
      el(
        "button",
        { class: "btn btn-ghost", onclick: () => app.startNewBatch() },
        ["＋ ", span("New batch")],
      ),
      el(
        "button",
        { class: "btn btn-ghost", onclick: () => app.exportCsv() },
        ["⬇ ", span("CSV")],
      ),
      el(
        "button",
        { class: "btn btn-primary", onclick: () => void app.generate() },
        ["⬇ ", span("Generate")],
      ),
    );
  }

  const brand = el("div", { class: "brand" }, [
    el("img", { src: `${import.meta.env.BASE_URL}icons/icon-192.png`, alt: "" }),
    document.createTextNode(APP_NAME),
  ]);

  const top = el("div", { class: "appbar-row" }, [
    brand,
    el("div", { class: "appbar-spacer" }),
    ...actions,
  ]);

  const children: (Node | string)[] = [top];

  if (batch) {
    const sub = el("div", { class: "appbar-sub" }, [
      el("strong", {}, [batch.employee || "—"]),
      document.createTextNode("  ·  "),
      document.createTextNode(batch.jobName || "Untitled job"),
      batch.jobNumber ? document.createTextNode(`  ·  #${batch.jobNumber}`) : null,
    ]);
    children.push(sub);
    if (processing) {
      children.push(
        el("div", { class: "appbar-sub" }, [
          `Reading ${app.remaining} receipt${app.remaining > 1 ? "s" : ""}…`,
        ]),
      );
    }
  }

  return el("header", { class: "appbar" }, children);
}

function span(text: string): HTMLElement {
  return el("span", { class: "appbar-actions-text" }, [text]);
}
