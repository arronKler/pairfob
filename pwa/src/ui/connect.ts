import {
  PAIR_CODE_WITH_LOCATOR_PATTERN,
  parseCodeAndLocator,
  parsePairingCode,
} from "../lib/pairing-input";
import { PairingScanError, scanPairingCode } from "../lib/pairing-scanner";
import { normalizeCrockford } from "../lib/protocol/bytes";
import { button, node } from "../lib/dom";
import { cancelAddComputer } from "../computers";
import { beginPairing, cancelPairing, onPairSubmit } from "../pairing";
import { render } from "../paint";
import { app, clearNotice, showError, showStatus, state } from "../state";
import { isDesk } from "../viewport";
import { backBar, brandNode, noteNode, spinnerNode } from "./chrome";

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
      showError("剪贴板里没有找到配对码。长按输入框粘贴也可以。");
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
    showStatus("浏览器没有允许读取剪贴板。长按输入框粘贴也可以。");
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

export function renderConnect(): void {
  const busy = state.phase === "pairing";
  const scanned = state.fragment;
  const adding = state.addingComputer || state.computers.length > 0;
  const wrap = node("div", adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`);
  if (adding) {
    wrap.append(backBar(state.addingComputer ? "添加另一台电脑" : "配对", cancelAddComputer));
  } else {
    wrap.append(brandNode());
    wrap.append(node("h1", "prelude-title", "连上你的电脑"));
  }
  wrap.append(
    node(
      "p",
      "lede",
      scanned
        ? "二维码已识别，正在安全连接电脑。"
        : state.addingComputer
          ? "先在那台电脑装好 pairfobd 并执行 pairfobd pair，再扫描它的二维码。无法扫码时，也可以输入配对码。"
          : "扫描电脑上的二维码。无法扫码时，也可以输入配对码。",
    ),
  );
  if (isDesk() && !adding && !scanned && !busy) {
    const hint = node(
      "p",
      "desk-hint",
      "这个页面是给手机或另一台设备用的。跑 Herdr 的电脑请执行 pairfobd pair，用那边扫终端里的码。",
    );
    hint.setAttribute("role", "note");
    wrap.append(hint);
  }
  if (scanned) wrap.append(node("p", "qr-note", "二维码只在这台手机上处理，配对码不会发送给 Pairfob 服务器。"));

  const form = node("form", "connect-form");
  form.noValidate = true;
  form.setAttribute("aria-busy", busy ? "true" : "false");
  const feedback = noteNode();
  if (busy) {
    const waiting = node("div", "pair-wait");
    waiting.append(
      spinnerNode(),
      node("p", "pair-wait-title", state.pairAwaitingApproval ? "等待电脑确认" : "正在验证配对码"),
      node("p", "pair-wait-copy", state.pairAwaitingApproval ? "请在电脑上按 Enter，随后会自动连接。" : "这通常只需要几秒钟。"),
    );
    form.append(waiting);
    const cancel = button("取消", "btn btn-ghost", cancelPairing);
    cancel.type = "button";
    form.append(cancel);
  } else {
    const scan = button("扫码连接", "btn-scan", async () => {
      try {
        const result = await scanPairingCode(location.origin);
        if (!result) return;
        state.fragment = result;
        state.pairCodeDraft = result.code;
        state.pairManualOpen = false;
        await beginPairing(result.code);
      } catch (error) {
        state.pairManualOpen = true;
        showError(error instanceof PairingScanError ? error.message : "扫码失败，请手动输入配对码。");
        render();
        focusPairCode();
      }
    });
    const manual = node("details", "manual-pair");
    manual.open = state.pairManualOpen || state.pairErrorTarget === "code";
    const summary = node("summary", "manual-pair-summary", "无法扫码？输入配对码");
    const manualBody = node("div", "manual-pair-body");
    const code = pairField({
      id: "pair-code",
      label: "配对码",
      name: "code",
      hint: "例如 7K3M-9H2P-WJ3K9M",
      value: state.pairCodeDraft,
      expected: 14,
      disabled: false,
      maxLength: 20,
      pattern: PAIR_CODE_WITH_LOCATOR_PATTERN,
      title: "输入电脑显示的配对码",
      required: true,
    });
    code.input.addEventListener("input", () => {
      state.pairCodeDraft = code.input.value;
    });
    bindPairError(code.input, code.field, feedback);
    manualBody.append(code.field, button("从剪贴板粘贴", "btn-paste", pasteFromClipboard));
    const submit = node("button", "btn btn-primary btn-connect");
    submit.type = "submit";
    submit.textContent = "连接";
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
  wrap.append(node("p", "trust", "端到端加密 · Pairfob 服务器也看不到会话内容"));
  app.replaceChildren(wrap);
  if (!busy) {
    const code = form.querySelector<HTMLInputElement>("#pair-code");
    if (state.pairManualOpen || state.pairErrorTarget) code?.focus({ preventScroll: true });
    else if (isDesk()) form.querySelector<HTMLButtonElement>(".btn-scan")?.focus({ preventScroll: true });
  }
}
