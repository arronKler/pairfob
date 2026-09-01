import { guardedReply } from "../../lib/guarded";
import { node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { type NoticeScope } from "../../lib/notice-scope";
import { type LiveSession } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import { reportMutationError } from "../../mutations";
import { requestPaneRefresh } from "../../pane-refresh-request";
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
  setDefaultComposeLive,
  setPaneComposeLive,
  showError,
  showStatus,
  state,
} from "../../state";
import { flushKeys, queueKey } from "./keys";
import { LiveInputPump, type LiveInputPumpState } from "./live-input";

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

function focusComposeField(field: HTMLTextAreaElement): void {
  state.composeFocused = true;
  // iOS pans the visual viewport to follow focus; the session shell already
  // tracks that rectangle, so a second document scroll would hide the field.
  field.focus({ preventScroll: true });
}

/** Tap the buffer to type into the PTY, the same way a desktop terminal focuses. */
export function focusCompose(): void {
  const field = composeField();
  if (!field) return;
  focusComposeField(field);
  const caret = field.value.length;
  field.setSelectionRange(caret, caret);
}

export function sizeCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
}

export function preserveCompose(): boolean {
  return state.composeIME || state.composeFocused || Boolean(state.composeDraft) || Boolean(liveInputText());
}

const batchPlaceholder = () => t("compose.batchPh");
const livePlaceholder = () => t("compose.livePh");
const LIVE_PREVIEW_CHARS = 80;

let liveInputPump: LiveInputPump | null = null;
let liveInputSession: LiveSession | null = null;
let liveInputPane = "";

function liveInputText(): string {
  if (liveInputPump && (liveInputSession !== state.live || liveInputPane !== state.paneId)) {
    liveInputPump.stop();
    liveInputPump = null;
    liveInputSession = null;
    liveInputPane = "";
  }
  return liveInputPump?.snapshot().visibleText ?? "";
}

export function liveInputPreview(text: string): string {
  const safe = text
    .replace(/\r\n?|\n/g, "↵")
    .replace(/\t/g, "⇥")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "·");
  const chars = Array.from(safe);
  return chars.length > LIVE_PREVIEW_CHARS ? `…${chars.slice(-LIVE_PREVIEW_CHARS).join("")}` : safe;
}

function applyLiveInputFeedback(
  form: HTMLFormElement,
  input: HTMLTextAreaElement,
  status: HTMLElement | null,
  text: string,
): void {
  const pending = state.composeLive && Boolean(text);
  form.classList.toggle("live-pending", pending);
  input.placeholder = pending
    ? t("compose.pendingPh", { text: liveInputPreview(text) })
    : state.composeLive
      ? livePlaceholder()
      : batchPlaceholder();
  const nextStatus = pending ? t("compose.pendingStatus", { n: Array.from(text).length }) : "";
  if (status && status.textContent !== nextStatus) status.textContent = nextStatus;
}

function syncLiveInputFeedback(snapshot?: LiveInputPumpState): void {
  const input = composeField();
  const form = input?.closest<HTMLFormElement>(".dock-form");
  if (!input || !form) return;
  const status = form.querySelector(".live-input-status") as HTMLElement | null;
  applyLiveInputFeedback(form, input, status, snapshot?.visibleText ?? liveInputText());
}

function stopLiveInputPump(): void {
  liveInputPump?.stop();
  liveInputPump = null;
  liveInputSession = null;
  liveInputPane = "";
  syncLiveInputFeedback();
}

function restoreLiveInput(text: string, paneId: string): void {
  if (!text || state.paneId !== paneId) return;
  const field = composeField();
  const current = field?.value ?? state.composeDraft;
  state.composeDraft = fitOperationPrompt(text + current).text;
  if (!field) return;
  field.value = state.composeDraft;
  sizeCompose(field);
  syncSendButton();
}

function ensureLiveInputPump(): LiveInputPump | null {
  const session = state.live;
  const paneId = state.paneId;
  if (!session || !paneId) return null;
  if (liveInputPump && liveInputSession === session && liveInputPane === paneId) return liveInputPump;
  stopLiveInputPump();

  let pump!: LiveInputPump;
  pump = new LiveInputPump({
    schedule: (run) => window.requestAnimationFrame(() => run()),
    cancel: (handle) => window.cancelAnimationFrame(handle as number),
    send: (text) => {
      if (state.live !== session || state.paneId !== paneId || !state.composeLive) {
        return Promise.reject(new ProtocolError("conflict", t("err.liveTarget")));
      }
      const request = session.sendText(paneId, text);
      void request.then(() => {
        if (state.live === session && state.paneId === paneId) clearNotice();
      }, () => undefined);
      return request;
    },
    // The mutation frame is already on the ordered socket when this runs.
    requestRead: () => { void requestPaneRefresh(); },
    onChange: (snapshot) => {
      if (liveInputPump === pump) syncLiveInputFeedback(snapshot);
    },
    onError: async (error, input) => {
      if (liveInputPump === pump) {
        liveInputPump = null;
        liveInputSession = null;
        liveInputPane = "";
      }
      const restore = error instanceof ProtocolError && error.code === "unknown_outcome"
        ? input.queuedText
        : input.failedText + input.queuedText;
      setPaneComposeLive(paneId, false);
      if (state.paneId === paneId) state.composeLive = false;
      restoreLiveInput(restore, paneId);
      syncLiveInputFeedback();
      await reportMutationError(session, error);
    },
  });
  liveInputPump = pump;
  liveInputSession = session;
  liveInputPane = paneId;
  return pump;
}

function typeLive(text: string): boolean {
  if (!text) return false;
  const pump = ensureLiveInputPump();
  if (!pump) return false;
  const queued = pump.snapshot().queuedText;
  const next = fitOperationPrompt(queued + text).text;
  const accepted = next.startsWith(queued) ? next.slice(queued.length) : "";
  if (!accepted || !pump.enqueue(accepted)) return false;
  haptic(4);
  return true;
}

export async function flushLiveInput(): Promise<boolean> {
  return liveInputPump ? liveInputPump.flush() : true;
}

function takeLiveField(input: HTMLTextAreaElement): void {
  const text = input.value;
  input.value = "";
  state.composeDraft = "";
  sizeCompose(input);
  syncSendButton();
  if (text && !typeLive(text)) restoreLiveInput(text, state.paneId);
}

export function syncComposeMode(): void {
  const form = app.querySelector(".dock-form") as HTMLFormElement | null;
  if (!form) return;
  form.classList.toggle("live", state.composeLive);
  const input = form.querySelector("textarea");
  if (input) {
    input.placeholder = state.composeLive ? livePlaceholder() : batchPlaceholder();
    input.setAttribute("aria-label", state.composeLive ? t("compose.liveAria") : t("compose.batchAria"));
  }
  const label = form.querySelector("label.sr-only");
  if (label) label.textContent = state.composeLive ? t("compose.liveAria") : t("compose.batchAria");
  syncLiveInputFeedback();
  syncSendButton();
}

export async function setComposeLive(on: boolean): Promise<void> {
  if (state.composeLive === on) {
    syncComposeMode();
    return;
  }
  const paneId = state.paneId;
  const session = state.live;
  if (paneId) setPaneComposeLive(paneId, on);
  if (state.composeLive) {
    await flushLiveInput();
    if (state.paneId !== paneId || state.live !== session) return;
    stopLiveInputPump();
    state.composeLive = false;
  } else {
    const draft = state.composeDraft;
    clearComposeDraft();
    state.composeLive = true;
    if (draft) typeLive(draft);
    await flushLiveInput();
    if (state.paneId !== paneId || state.live !== session) return;
  }
  syncComposeMode();
}

/**
 * The dock action is always Enter. Empty Enter is a deliberate PTY keypress,
 * including when an agent's own TUI is asking for confirmation.
 */
export function syncSendButton(send = app.querySelector(".dock-form .send-btn") as HTMLButtonElement | null): void {
  if (!send) return;
  send.removeAttribute("aria-busy");
  if (submitBusy && !state.composeLive) {
    send.disabled = true;
    send.textContent = t("compose.sending");
    send.setAttribute("aria-busy", "true");
    send.setAttribute("aria-label", t("compose.sendingAria"));
    return;
  }
  send.disabled = false;
  send.textContent = "Enter";
  if (state.composeDraft.trim()) send.setAttribute("aria-label", t("compose.sendEnterAria"));
  else send.setAttribute("aria-label", t("compose.enterAria"));
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
    void flushLiveInput().then((sent) => {
      if (sent) queueKey("enter");
    });
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
  focusComposeField(field);
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
  focusComposeField(field);
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
  focusComposeField(field);
  field.setSelectionRange(next.length, next.length);
  haptic(4);
}

const stallNotice = () => t("compose.stall");
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
  if (!(await flushLiveInput())) return;
  queueKey("enter");
}

export async function submitTyped(allowBareEnter = false): Promise<void> {
  if (state.composeLive) {
    if (!allowBareEnter) return;
    await submitLiveEnter();
    return;
  }
  const session = state.live;
  if (!session || !state.paneId || submitBusy) return;
  const paneId = state.paneId;
  const text = state.composeDraft;
  if (!text.trim()) {
    if (allowBareEnter) queueKey("enter");
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
        showError(stallNotice(), noticeScope, true);
        render();
      } else {
        clearNoticeForScope(noticeScope);
      }
      return;
    }
    markPaneSubmitted(paneId);
    haptic(8);
    clearNoticeForScope(noticeScope);
    await requestPaneRefresh();
  } catch (error) {
    await reportMutationError(session, error);
  } finally {
    submitBusy = false;
    syncSendButton();
  }
}

export async function sendPad(key: string): Promise<void> {
  if (key === "enter") {
    await submitTyped(true);
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
    void submitTyped(true);
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
        focusComposeField(field);
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

const composeModeLabel = () => t("pane.inputAria");

export function syncComposeLiveControl(): void {
  for (const bar of app.querySelectorAll(`[aria-label="${composeModeLabel()}"]`)) {
    for (const item of bar.querySelectorAll("button")) {
      const live = item.dataset.live === "1";
      const selected = state.defaultComposeLive === live;
      item.classList.toggle("on", selected);
      item.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }
}

export function composeLiveControl(): HTMLElement {
  const bar = node("div", "seg compose-live");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", composeModeLabel());
  for (const option of [
    { live: false, label: t("compose.batch") },
    { live: true, label: t("compose.live") },
  ]) {
    const selected = state.defaultComposeLive === option.live;
    const item = node("button", `seg-item${selected ? " on" : ""}`, option.label);
    item.type = "button";
    item.dataset.live = option.live ? "1" : "0";
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", selected ? "true" : "false");
    item.addEventListener("click", () => {
      if (state.defaultComposeLive === option.live) return;
      setDefaultComposeLive(option.live);
      syncComposeLiveControl();
    });
    bar.append(item);
  }
  return bar;
}

export function composeForm(includeBack: boolean): { form: HTMLFormElement; input: HTMLTextAreaElement } {
  const form = node("form", `dock-form${state.composeLive ? " live" : ""}`);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitTyped(true);
  });
  const input = node("textarea");
  const inputID = includeBack ? "compose-text-mobile" : "compose-text-desktop";
  const inputLabel = node("label", "sr-only", state.composeLive ? t("compose.liveAria") : t("compose.batchAria"));
  const liveStatus = node("span", "sr-only live-input-status");
  inputLabel.htmlFor = inputID;
  liveStatus.id = `${inputID}-live-status`;
  liveStatus.setAttribute("role", "status");
  liveStatus.setAttribute("aria-live", "polite");
  input.id = inputID;
  input.name = "pairfob-compose";
  input.rows = 1;
  input.wrap = "soft";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "none";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.setAttribute("aria-describedby", liveStatus.id);
  input.placeholder = state.composeLive ? livePlaceholder() : batchPlaceholder();
  input.enterKeyHint = "enter";
  input.maxLength = OPERATION_INPUT_LIMITS.prompt;
  bindTermField(input);
  const send = node("button", "send-btn", "Enter");
  send.type = "submit";
  syncSendButton(send);
  form.append(inputLabel, liveStatus, input, send);
  applyLiveInputFeedback(form, input, liveStatus, liveInputText());
  return { form, input };
}
