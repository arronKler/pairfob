import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";

export type Sheet = { dialog: HTMLDialogElement; form: HTMLFormElement; body: HTMLElement; close: () => void };

let sheetSerial = 0;

/** Ignore backdrop taps that are still the gesture that opened the sheet. */
const OPEN_GESTURE_MS = 400;

export function sheet(title: string): Sheet {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal sheet");
  const titleID = `sheet-title-${++sheetSerial}`;
  dialog.setAttribute("aria-labelledby", titleID);
  const form = node("form");
  form.method = "dialog";
  const heading = node("h2", "modal-title", title);
  heading.id = titleID;
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const dismiss = button("×", "icon-btn sheet-close", close);
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", t("close"));
  const head = node("div", "sheet-head");
  head.append(heading, dismiss);
  const body = node("div", "sheet-body");
  form.append(head, body);
  dialog.append(form);
  const openedAt = performance.now();
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (performance.now() - openedAt < OPEN_GESTURE_MS) return;
    close();
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      trigger?.focus();
    },
    { once: true },
  );
  return { dialog, form, body, close };
}

/** WebKit drops showModal() that runs in the same turn as dialog.close(). */
export function afterClose(dialog: HTMLDialogElement, action: () => void | Promise<void>): void {
  const run = () => {
    window.setTimeout(() => void action(), 0);
  };
  if (!dialog.open) {
    run();
    return;
  }
  dialog.addEventListener("close", run, { once: true });
  dialog.close();
}

export function present(parts: Sheet): void {
  // A sheet left open swallows every tap on the page beneath it, so never stack
  // two. Reopening always replaces rather than layers.
  for (const stale of document.querySelectorAll("dialog.sheet")) stale.remove();
  document.body.append(parts.dialog);
  parts.dialog.showModal();
  (parts.form.querySelector("button:not(:disabled):not(.sheet-close)") as HTMLButtonElement | null)?.focus();
}

export function sheetItem(
  parts: Sheet,
  label: string,
  action: () => void | Promise<void>,
  variant: "" | "danger" = "",
  disabled = false,
): HTMLButtonElement {
  const el = button(label, `menu-item${variant ? ` menu-${variant}` : ""}`, () => afterClose(parts.dialog, action));
  el.disabled = disabled;
  return el;
}

export function sheetSection(parts: Sheet, label: string, entries: HTMLButtonElement[]): void {
  if (entries.length) parts.body.append(node("h3", "menu-section-title", label), ...entries);
}
