import { guardedReply } from "../../lib/guarded";
import { node } from "../../lib/dom";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { type NoticeScope } from "../../lib/notice-scope";
import { type LiveSession } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import { refreshPane } from "../../live";
import { reportMutationError } from "../../mutations";
import { render } from "../../paint";
import {
  COMPOSE_MAX_PX,
  COMPOSE_MIN_PX,
  app,
  captureNoticeScope,
  clearNotice,
  clearNoticeForScope,
  haptic,
  markPaneSubmitted,
  noticeScopeIsCurrent,
  saveComposeLive,
  showError,
  showStatus,
  state,
} from "../../state";
import { flushKeys, queueKey } from "./keys";

const SPECIAL_KEYS: Record<string, string> = {
  Enter: "enter",
  Escape: "esc",
  Tab: "tab",
  Backspace: "backspace",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function composeField(): HTMLTextAreaElement | null {
  return app.querySelector(".dock-form textarea");
}

/** Tap the buffer to type into the PTY, the same way a desktop terminal focuses. */
export function focusCompose(): void {
  const field = composeField();
  if (!field) return;
  state.composeFocused = true;
  field.focus();
  const caret = field.value.length;
  field.setSelectionRange(caret, caret);
}

export function sizeCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
}

export function preserveCompose(): boolean {
  return state.composeIME || state.composeFocused || Boolean(state.composeDraft);
}

const LIVE_FLUSH_MS = 55;
const BATCH_PLACEHOLDER = "组字 · 写完再发送";
const LIVE_PLACEHOLDER = "实时 · 边打边进终端";

let livePending = "";
let livePane = "";
let liveTimer: number | null = null;
let liveFlushing = false;

function typeLive(text: string): void {
  if (!text || !state.live || !state.paneId) return;
  if (livePane && livePane !== state.paneId) livePending = "";
  livePane = state.paneId;
  const next = fitOperationPrompt(livePending + text).text;
  if (next === livePending) return;
  livePending = next;
  haptic(4);
  if (liveTimer === null) liveTimer = window.setTimeout(() => void flushLiveInput(), LIVE_FLUSH_MS);
}

export async function flushLiveInput(): Promise<void> {
  if (liveTimer !== null) {
    window.clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (liveFlushing || !livePending) return;
  const session = state.live;
  const paneId = livePane;
  const text = livePending;
  livePending = "";
  if (!session || !paneId || paneId !== state.paneId) return;
  liveFlushing = true;
  try {
    await session.sendText(paneId, text);
    clearNotice();
    await refreshPane();
  } catch (error) {
    if (!(error instanceof ProtocolError && error.code === "unknown_outcome")) {
      const field = composeField();
      if (field && state.paneId === paneId) {
        field.value = text + field.value;
        state.composeDraft = fitOperationPrompt(field.value).text;
        field.value = state.composeDraft;
        sizeCompose(field);
      }
    }
    await reportMutationError(session, error);
  } finally {
    liveFlushing = false;
    if (livePending) void flushLiveInput();
  }
}

function takeLiveField(input: HTMLTextAreaElement): void {
  const text = input.value;
  input.value = "";
  state.composeDraft = "";
  sizeCompose(input);
  syncSendButton();
  if (text) typeLive(text);
}

export function syncComposeMode(): void {
  const form = app.querySelector(".dock-form") as HTMLFormElement | null;
  if (!form) return;
  form.classList.toggle("live", state.composeLive);
  const input = form.querySelector("textarea");
  if (input) {
    input.placeholder = state.composeLive ? LIVE_PLACEHOLDER : BATCH_PLACEHOLDER;
    input.setAttribute("aria-label", state.composeLive ? "实时输入到终端" : "给终端组字");
  }
  const label = form.querySelector("label.sr-only");
  if (label) label.textContent = state.composeLive ? "实时输入到终端" : "给终端组字";
  syncSendButton();
}

export async function setComposeLive(on: boolean): Promise<void> {
  if (state.composeLive === on) {
    syncComposeMode();
    return;
  }
  if (state.composeLive) {
    await flushLiveInput();
    state.composeLive = false;
  } else {
    const draft = state.composeDraft;
    clearComposeDraft();
    state.composeLive = true;
    if (draft) typeLive(draft);
    await flushLiveInput();
  }
  saveComposeLive();
  syncComposeMode();
  syncComposeLiveControl();
}

/**
 * 发送 is the text affordance. With an empty draft a tap would put a bare Enter
 * into whatever the TUI has highlighted — on a phone that button sits under the
 * thumb, so an accidental tap would confirm a destructive default. A deliberate
 * bare Enter still has the keypad's Enter key.
 */
export function syncSendButton(): void {
  const send = app.querySelector(".dock-form .send-btn") as HTMLButtonElement | null;
  if (!send) return;
  send.removeAttribute("aria-busy");
  if (submitBusy && !state.composeLive) {
    send.disabled = true;
    send.textContent = "发送中…";
    send.setAttribute("aria-busy", "true");
    return;
  }
  if (state.composeLive) {
    send.disabled = false;
    send.textContent = "Enter";
    send.setAttribute("aria-label", "向终端发送 Enter");
    return;
  }
  send.textContent = "发送";
  send.removeAttribute("aria-label");
  send.disabled = !state.composeDraft.trim();
}

function clearComposeDraft(): void {
  state.composeDraft = "";
  const field = composeField();
  if (!field) return;
  field.value = "";
  sizeCompose(field);
  syncSendButton();
}

/** Soft keyboards have no Shift+Enter, so newlines need their own affordance. */
export function insertNewline(): void {
  if (state.composeLive) {
    void flushLiveInput().then(() => queueKey("enter"));
    return;
  }
  const field = composeField();
  if (!field) {
    state.composeDraft += "\n";
    return;
  }
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText("\n", start, end, "end");
  state.composeDraft = field.value;
  sizeCompose(field);
  syncSendButton();
  field.focus();
  haptic(4);
}

export function insertCompose(text: string): void {
  if (state.composeLive) {
    typeLive(text);
    return;
  }
  const field = composeField();
  const addition = state.composeDraft && !state.composeDraft.endsWith(" ") ? ` ${text}` : text;
  if (!field) {
    state.composeDraft = fitOperationPrompt(state.composeDraft + addition).text;
    return;
  }
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(addition, start, end, "end");
  state.composeDraft = fitOperationPrompt(field.value).text;
  field.value = state.composeDraft;
  sizeCompose(field);
  syncSendButton();
  state.composeFocused = true;
  field.focus();
}

/** Replace the draft with a slash token. Does not send Enter. */
export function setComposeText(text: string): void {
  if (state.composeLive) {
    typeLive(text);
    return;
  }
  const next = fitOperationPrompt(text).text;
  state.composeDraft = next;
  const field = composeField();
  if (!field) return;
  field.value = next;
  sizeCompose(field);
  syncSendButton();
  state.composeFocused = true;
  field.focus();
  field.setSelectionRange(next.length, next.length);
  haptic(4);
}

const SUBMIT_PENDING_NOTICE = "文字已输入，正在等待终端确认；确认后会自动按 Enter。";
const STALL_NOTICE = "文字已输入，但终端长时间没有显示可核验的回显。为避免误操作，已停止自动按 Enter；请先查看当前画面。";
// Must match the daemon's guarded Enter read. Herdr protocol 19 interprets
// lines=0 as a zero-row snapshot, so an explicit positive window is required.
const GUARDED_PANE_READ_LINES = 80;

let submitBusy = false;

const RETRYABLE_GUARDED_READ = new Set(["backpressure", "daemon_replaced", "disconnected", "reconnecting", "timeout", "unbound"]);

async function guardedSubmit(
  session: LiveSession,
  paneId: string,
  text: string,
  noticeScope: NoticeScope,
): Promise<"sent" | "stalled" | "cancelled"> {
  return guardedReply({
    text,
    isActive: () => state.live === session && state.screen === "pane" && state.paneId === paneId && noticeScopeIsCurrent(noticeScope),
    sendText: async (value) => {
      await session.sendText(paneId, value);
      if (state.composeDraft === value) clearComposeDraft();
      if (state.live === session && noticeScopeIsCurrent(noticeScope)) {
        showStatus(SUBMIT_PENDING_NOTICE, true, noticeScope);
        render();
      }
    },
    // Matching the daemon's bounds makes this hash a proof of the exact screen
    // it will check immediately before sending Enter.
    read: async () => session.paneRead(paneId, GUARDED_PANE_READ_LINES, "text"),
    retryRead: (error) => error instanceof ProtocolError && RETRYABLE_GUARDED_READ.has(error.code),
    sendEnter: async ({ expectedPrompt: prompt, expectedSignature }) => {
      await session.sendKeys(paneId, ["enter"], {
        intent: "submit",
        expected_prompt: prompt,
        expected_signature: expectedSignature,
      });
    },
  });
}

async function submitLiveEnter(): Promise<void> {
  await flushLiveInput();
  queueKey("enter");
}

export async function submitTyped(): Promise<void> {
  if (state.composeLive) {
    await submitLiveEnter();
    return;
  }
  const session = state.live;
  if (!session || !state.paneId || submitBusy) return;
  const paneId = state.paneId;
  const text = state.composeDraft;
  if (!text) {
    queueKey("enter");
    return;
  }
  submitBusy = true;
  syncSendButton();
  const noticeScope = captureNoticeScope();
  try {
    await flushKeys();
    const outcome = await guardedSubmit(session, paneId, text, noticeScope);
    if (outcome === "cancelled") {
      clearNoticeForScope(noticeScope);
      return;
    }
    if (outcome === "stalled") {
      if (state.live === session && noticeScopeIsCurrent(noticeScope)) {
        showError(STALL_NOTICE, noticeScope);
        render();
      } else {
        clearNoticeForScope(noticeScope);
      }
      return;
    }
    markPaneSubmitted(paneId);
    haptic(8);
    clearNoticeForScope(noticeScope);
    await refreshPane();
  } catch (error) {
    await reportMutationError(session, error);
  } finally {
    submitBusy = false;
    syncSendButton();
  }
}

export async function sendPad(key: string): Promise<void> {
  if (key === "enter") {
    await submitTyped();
    return;
  }
  queueKey(key);
}

function fieldHasSelection(input: HTMLTextAreaElement): boolean {
  return input.selectionStart !== input.selectionEnd;
}

export function handlePaneKey(event: KeyboardEvent, fromField: boolean): void {
  if (event.isComposing || state.composeIME) return;
  // Tab is how a keyboard reaches the chrome and the dock at all, and the pane
  // opens with focus on the body. Only the compose field keeps Tab for TUI
  // completion, and never with Shift, so focus can always back out.
  if (event.key === "Tab" && (!fromField || event.shiftKey)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitTyped();
    return;
  }
  if (event.key === "Backspace" && fromField && !state.composeDraft) {
    event.preventDefault();
    queueKey("backspace");
    return;
  }
  if (event.ctrlKey && !event.metaKey && /^[a-z]$/i.test(event.key)) {
    const input = fromField ? composeField() : null;
    if (input && event.key.toLowerCase() === "c" && fieldHasSelection(input)) return;
    event.preventDefault();
    queueKey(`ctrl+${event.key.toLowerCase()}`);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const special = SPECIAL_KEYS[event.key];
  if (!special || event.key === "Enter" || event.key === "Backspace") {
    if (!fromField && event.key.length === 1) {
      event.preventDefault();
      if (state.composeLive) {
        typeLive(event.key);
        return;
      }
      const next = fitOperationPrompt(state.composeDraft + event.key).text;
      if (next === state.composeDraft) return;
      state.composeDraft = next;
      const field = composeField();
      if (field) {
        field.value = state.composeDraft;
        state.composeFocused = true;
        field.focus();
        field.setSelectionRange(state.composeDraft.length, state.composeDraft.length);
        sizeCompose(field);
      }
    }
    return;
  }
  if (fromField && state.composeDraft && event.key.startsWith("Arrow")) return;
  event.preventDefault();
  queueKey(special);
}

function bindTermField(input: HTMLTextAreaElement): void {
  state.composeDraft = fitOperationPrompt(state.composeDraft).text;
  input.value = state.composeDraft;
  sizeCompose(input);
  input.addEventListener("input", () => {
    if (state.composeLive) {
      if (state.composeIME) {
        state.composeDraft = input.value;
        sizeCompose(input);
        return;
      }
      takeLiveField(input);
      return;
    }
    state.composeDraft = fitOperationPrompt(input.value).text;
    input.value = state.composeDraft;
    sizeCompose(input);
    syncSendButton();
  });
  input.addEventListener("compositionstart", () => {
    state.composeIME = true;
  });
  input.addEventListener("compositionend", () => {
    state.composeIME = false;
    if (state.composeLive) {
      takeLiveField(input);
      return;
    }
    state.composeDraft = fitOperationPrompt(input.value).text;
    input.value = state.composeDraft;
    sizeCompose(input);
    syncSendButton();
  });
  input.addEventListener("focus", () => {
    state.composeFocused = true;
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== composeField()) state.composeFocused = false;
    }, 0);
  });
  input.addEventListener("keydown", (event) => handlePaneKey(event, true));
}

const COMPOSE_MODE_LABEL = "终端输入方式";

export function syncComposeLiveControl(): void {
  for (const bar of app.querySelectorAll(`[aria-label="${COMPOSE_MODE_LABEL}"]`)) {
    for (const item of bar.querySelectorAll("button")) {
      const live = item.dataset.live === "1";
      const selected = state.composeLive === live;
      item.classList.toggle("on", selected);
      item.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }
}

export function composeLiveControl(): HTMLElement {
  const bar = node("div", "seg compose-live");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", COMPOSE_MODE_LABEL);
  for (const option of [
    { live: false, label: "组字" },
    { live: true, label: "实时" },
  ]) {
    const selected = state.composeLive === option.live;
    const item = node("button", `seg-item${selected ? " on" : ""}`, option.label);
    item.type = "button";
    item.dataset.live = option.live ? "1" : "0";
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.addEventListener("click", () => {
      if (state.composeLive === option.live) return;
      void setComposeLive(option.live).then(() => composeField()?.focus());
    });
    bar.append(item);
  }
  return bar;
}

export function composeForm(includeBack: boolean): { form: HTMLFormElement; input: HTMLTextAreaElement } {
  const form = node("form", `dock-form${state.composeLive ? " live" : ""}`);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitTyped();
  });
  const input = node("textarea");
  const inputID = includeBack ? "compose-text-mobile" : "compose-text-desktop";
  const inputLabel = node("label", "sr-only", state.composeLive ? "实时输入到终端" : "给终端组字");
  inputLabel.htmlFor = inputID;
  input.id = inputID;
  input.name = "pairfob-compose";
  input.rows = 1;
  input.wrap = "soft";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "none";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.placeholder = state.composeLive ? LIVE_PLACEHOLDER : BATCH_PLACEHOLDER;
  input.enterKeyHint = "enter";
  input.maxLength = OPERATION_INPUT_LIMITS.prompt;
  bindTermField(input);
  const send = node("button", "send-btn", state.composeLive ? "Enter" : submitBusy ? "发送中…" : "发送");
  send.type = "submit";
  if (state.composeLive) send.setAttribute("aria-label", "向终端发送 Enter");
  if (submitBusy && !state.composeLive) send.setAttribute("aria-busy", "true");
  send.disabled = !state.composeLive && (submitBusy || !state.composeDraft.trim());
  form.append(inputLabel, input, send);
  return { form, input };
}
