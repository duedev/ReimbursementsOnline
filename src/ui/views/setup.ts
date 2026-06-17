import { el } from "../dom.ts";
import { formatDate, toIso } from "../../util/format.ts";
import type { App } from "../app.ts";

// Zero-config first run (§3, §10): a single short form, strong defaults, then
// straight to capture. No accounts, no settings.

export function renderSetup(app: App): HTMLElement {
  const employee = el("input", { type: "text", placeholder: "e.g. Ada Lovelace", autocomplete: "name" }) as HTMLInputElement;
  const jobName = el("input", { type: "text", placeholder: "e.g. Q1 Client Visit" }) as HTMLInputElement;
  const jobNumber = el("input", { type: "text", placeholder: "optional" }) as HTMLInputElement;

  const submit = (): void => {
    void app.newBatch({
      employee: employee.value.trim(),
      jobName: jobName.value.trim() || `Reimbursement ${formatDate(toIso(new Date()))}`,
      jobNumber: jobNumber.value.trim(),
    });
  };

  const form = el("div", { class: "panel" }, [
    el("div", { class: "field" }, [
      el("label", {}, ["Employee / submitter"]),
      employee,
    ]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field" }, [el("label", {}, ["Job / trip name"]), jobName]),
      el("div", { class: "field" }, [el("label", {}, ["Job number"]), jobNumber]),
    ]),
    el(
      "button",
      { class: "btn btn-accent btn-lg", style: "width:100%", onclick: submit },
      ["Start a new report  →"],
    ),
  ]);

  employee.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") jobName.focus();
  });
  jobNumber.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });

  const resume =
    app.knownBatches.length > 0
      ? el("div", { style: "margin-top:22px" }, [
          el("p", { class: "section-title" }, ["Recent reports"]),
          el(
            "div",
            { class: "stats", style: "flex-direction:column;align-items:stretch" },
            app.knownBatches.slice(0, 6).map((b) =>
              el(
                "button",
                {
                  class: "btn btn-soft",
                  style: "justify-content:space-between;width:100%",
                  onclick: () => void app.switchBatch(b.id),
                },
                [
                  el("span", {}, [b.jobName || "Untitled"]),
                  el("span", { class: "date" }, [formatDate(toIso(new Date(b.createdAt)))]),
                ],
              ),
            ),
          ),
        ])
      : null;

  return el("div", { class: "setup" }, [
    el("h1", {}, ["Receipts → a polished report"]),
    el("p", { class: "lede" }, [
      "Snap or drop your receipts. They're read on your device — free, private, no install. ",
      "Review in a tap, then download a tidy spreadsheet.",
    ]),
    form,
    resume,
  ]);
}
