import {
  PAIR_CODE_WITH_LOCATOR_PATTERN,
  parseCodeAndLocator,
  parsePairingCode,
} from "../lib/pairing-input";
import { PairingScanError, scanPairingCode } from "../lib/pairing-scanner";
import { normalizeCrockford } from "../lib/protocol/bytes";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { cancelAddComputer } from "../computers";
import { beginPairing, cancelPairing, onPairSubmit } from "../pairing";
import { render } from "../paint";
import { app, clearNotice, showError, showStatus, state } from "../state";
import { isDesk } from "../viewport";
import { backBar, brandNode, languageSelect, noteNode, spinnerNode } from "./chrome";

function pairField(opts: {
  id: string;
  label: string;
  name: string;
  hint: string;
  value: string;
  expected: number;
  disabled: boolean;
  maxLength: number;
  pattern: string;
  title: string;
  required: boolean;
}): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = node("label", "field");
  field.htmlFor = opts.id;
  const head = node("div", "field-head");
  head.append(node("span", "field-label", opts.label));
  const count = node("span", "field-count");
  const paintCount = (value: string) => {
    const length = normalizeCrockford(value).length;
    if (!length) {
      count.textContent = "";
      count.hidden = true;
      count.classList.remove("ok");
      return;
    }
    count.hidden = false;
    count.textContent = `${length}/${opts.expected}`;
    count.classList.toggle("ok", length === opts.expected);
  };
  paintCount(opts.value);
  head.append(count);
  const input = node("input");
  input.id = opts.id;
  input.name = opts.name;
  input.type = "text";
  input.autocomplete = "one-time-code";
  input.spellcheck = false;
  input.autocapitalize = "characters";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.placeholder = opts.hint;
  input.value = opts.value;
  input.disabled = opts.disabled;
  input.maxLength = opts.maxLength;
  input.required = opts.required;
  input.pattern = opts.pattern;
  input.title = opts.title;
  input.addEventListener("input", () => paintCount(input.value));
  field.append(head, input);
  return { field, input };
}

function focusPairCode(): void {
  queueMicrotask(() => (app.querySelector("#pair-code") as HTMLInputElement | null)?.focus({ preventScroll: true }));
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    const both = parseCodeAndLocator(text);
    if (both) {
      state.pairCodeDraft = `${both.code.slice(0, 4)}-${both.code.slice(4)}-${both.loc}`;
      state.pairManualOpen = true;
      state.pairErrorTarget = null;
      clearNotice();
      render();
      (app.querySelector(".btn-connect") as HTMLButtonElement | null)?.focus();
      return;
    }
    const code = parsePairingCode(text);
    if (!code) {
      state.pairManualOpen = true;
      state.pairErrorTarget = "code";
      showError(t("err.noClipboardCode"));
      render();
      focusPairCode();
      return;
    }
    state.pairCodeDraft = code;
    state.pairManualOpen = true;
    state.pairErrorTarget = null;
    clearNotice();
    render();
    (app.querySelector(".btn-connect") as HTMLButtonElement | null)?.focus();
  } catch {
    state.pairManualOpen = true;
    showStatus(t("err.clipboardDenied"));
    render();
    focusPairCode();
  }
}

function bindPairError(input: HTMLInputElement, field: HTMLLabelElement, feedback: HTMLElement | null): void {
  if (!feedback || state.pairErrorTarget !== input.name) return;
  feedback.id = "pair-feedback";
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", feedback.id);
  field.append(feedback);
}

function connectLang(): HTMLElement {
  const lang = node("div", "connect-lang");
  lang.append(languageSelect());
  return lang;
}

export function renderConnect(): void {
  const busy = state.phase === "pairing";
  const scanned = state.fragment;
  const adding = state.addingComputer || state.computers.length > 0;
  const wrap = node("div", adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`);
  if (adding) {
    const bar = backBar(state.addingComputer ? t("settings.addComputer") : t("connect.pair"), cancelAddComputer);
    bar.append(connectLang());
    wrap.append(bar);
  } else {
    wrap.append(brandNode());
    wrap.append(node("h1", "prelude-title", t("connect.title")));
  }
  wrap.append(
    node(
      "p",
      "lede",
      scanned
        ? t("connect.ledeScanned")
        : state.addingComputer
          ? t("connect.ledeAdd")
          : t("connect.ledeScan"),
    ),
  );
  if (isDesk() && !adding && !scanned && !busy) {
    const hint = node(
      "p",
      "desk-hint",
      t("connect.deskHint"),
    );
    hint.setAttribute("role", "note");
    wrap.append(hint);
  }
  if (scanned) wrap.append(node("p", "qr-note", t("connect.qrNote")));

  const form = node("form", "connect-form");
  form.noValidate = true;
  form.setAttribute("aria-busy", busy ? "true" : "false");
  const feedback = noteNode();
  if (busy) {
    const waiting = node("div", "pair-wait");
    waiting.append(
      spinnerNode(),
      node("p", "pair-wait-title", state.pairAwaitingApproval ? t("connect.waitEnter") : t("connect.waitTitle")),
      node("p", "pair-wait-copy", state.pairAwaitingApproval ? t("connect.waitEnterCopy") : t("connect.waitCopy")),
    );
    form.append(waiting);
    const cancel = button(t("cancel"), "btn btn-ghost", cancelPairing);
    cancel.type = "button";
    form.append(cancel);
  } else {
    const scan = button(t("connect.scan"), "btn-scan", async () => {
      try {
        const result = await scanPairingCode(location.origin);
        if (!result) return;
        state.fragment = result;
        state.pairCodeDraft = result.code;
        state.pairManualOpen = false;
        await beginPairing(result.code);
      } catch (error) {
        state.pairManualOpen = true;
        showError(error instanceof PairingScanError ? error.message : t("err.scanFailed"));
        render();
        focusPairCode();
      }
    });
    const manual = node("details", "manual-pair");
    manual.open = state.pairManualOpen || state.pairErrorTarget === "code";
    const summary = node("summary", "manual-pair-summary", t("connect.manualSummary"));
    const manualBody = node("div", "manual-pair-body");
    const code = pairField({
      id: "pair-code",
      label: t("connect.pairCode"),
      name: "code",
      hint: t("connect.pairHint"),
      value: state.pairCodeDraft,
      expected: 14,
      disabled: false,
      maxLength: 20,
      pattern: PAIR_CODE_WITH_LOCATOR_PATTERN,
      title: t("connect.pairTitle"),
      required: true,
    });
    code.input.addEventListener("input", () => {
      state.pairCodeDraft = code.input.value;
    });
    bindPairError(code.input, code.field, feedback);
    manualBody.append(code.field, button(t("connect.paste"), "btn-paste", pasteFromClipboard));
    const submit = node("button", "btn btn-primary btn-connect");
    submit.type = "submit";
    submit.textContent = t("connect.submit");
    manualBody.append(submit);
    manual.append(summary, manualBody);
    manual.addEventListener("toggle", () => {
      state.pairManualOpen = manual.open;
      if (manual.open) focusPairCode();
    });
    form.append(scan, manual);
    form.addEventListener("submit", onPairSubmit);
  }
  wrap.append(form);
  if (!state.pairErrorTarget && feedback) wrap.append(feedback);
  wrap.append(node("p", "trust", t("connect.trust")));
  if (!adding) wrap.append(connectLang());
  app.replaceChildren(wrap);
  if (!busy) {
    const code = form.querySelector<HTMLInputElement>("#pair-code");
    if (state.pairManualOpen || state.pairErrorTarget) code?.focus({ preventScroll: true });
    else if (isDesk()) form.querySelector<HTMLButtonElement>(".btn-scan")?.focus({ preventScroll: true });
  }
}
