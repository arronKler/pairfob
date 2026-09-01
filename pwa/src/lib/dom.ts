import { t } from "./i18n.ts";

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(
  text: string,
  className = "btn",
  action?: () => void | Promise<void>,
): HTMLButtonElement {
  const element = node("button", className, text);
  element.type = "button";
  if (action) element.addEventListener("click", () => void action());
  return element;
}

export function labeledInput(
  label: string,
  name: string,
  placeholder: string,
  value = "",
  disabled = false,
): HTMLLabelElement {
  const wrapper = node("label");
  wrapper.append(document.createTextNode(label));
  const input = node("input");
  input.name = name;
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = value;
  input.disabled = disabled;
  wrapper.append(input);
  return wrapper;
}

let dialogSerial = 0;

function restoreFocus(trigger: HTMLElement | null): void {
  queueMicrotask(() => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
}

function modal(title: string): {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  trigger: HTMLElement | null;
} {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal");
  const form = node("form");
  const titleId = `modal-title-${++dialogSerial}`;
  const heading = node("h2", "modal-title", title);
  heading.id = titleId;
  dialog.setAttribute("aria-labelledby", titleId);
  form.method = "dialog";
  form.append(heading);
  dialog.append(form);
  const openedAt = performance.now();
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (performance.now() - openedAt < 400) return;
    dialog.close("cancel");
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (performance.now() - openedAt < 400) return;
    dialog.close("cancel");
  });
  return { dialog, form, trigger };
}

export function askText(title: string, initial = "", maxLength?: number, fieldLabel?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { dialog, form, trigger } = modal(title);
    const field = labeledInput(fieldLabel ?? t("op.fieldName"), "value", "", initial);
    const input = field.querySelector("input") as HTMLInputElement;
    if (maxLength !== undefined) input.maxLength = maxLength;
    const actions = node("div", "action-row");
    const cancel = button(t("cancel"), "btn btn-small btn-ghost", () => dialog.close("cancel"));
    const submit = node("button", "btn btn-small btn-primary", t("confirm"));
    submit.type = "submit";
    actions.append(submit, cancel);
    form.append(field, actions);
    dialog.addEventListener("close", () => {
      const result = dialog.returnValue === "cancel" ? null : input.value;
      dialog.remove();
      restoreFocus(trigger);
      resolve(result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

export type HelpBlock = string | HTMLElement;

/** Centered read-only copy. Stays a dialog, not the mobile action sheet. */
export function showHelp(title: string, blocks: HelpBlock[]): void {
  for (const stale of document.querySelectorAll("dialog.help")) stale.remove();
  const { dialog, form, trigger } = modal(title);
  dialog.classList.add("help");
  const heading = form.querySelector("h2.modal-title");
  const dismiss = button("×", "icon-btn help-close", () => dialog.close());
  dismiss.setAttribute("aria-label", t("close"));
  const head = node("div", "help-head");
  if (heading) head.append(heading);
  head.append(dismiss);
  form.prepend(head);
  const described: string[] = [];
  for (const block of blocks) {
    const el = typeof block === "string" ? node("p", "help-copy", block) : block;
    if (!el.id) el.id = `help-copy-${dialogSerial}-${described.length}`;
    described.push(el.id);
    form.append(el);
  }
  if (described.length) dialog.setAttribute("aria-describedby", described.join(" "));
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      restoreFocus(trigger);
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  dismiss.focus();
}

export function askConfirm(message: string, confirmLabel?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, form, trigger } = modal(t("op.dangerTitle"));
    form.append(node("p", "lede", message));
    const actions = node("div", "action-row");
    const cancel = button(t("cancel"), "btn btn-small btn-ghost", () => dialog.close("cancel"));
    cancel.autofocus = true;
    actions.append(button(confirmLabel ?? t("confirm"), "btn btn-small btn-danger", () => dialog.close("confirm")), cancel);
    form.append(actions);
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "confirm";
      dialog.remove();
      restoreFocus(trigger);
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
