import { appRoot } from "../../../app/dom-root";
import {
  COMPOSE_MAX_PX,
  COMPOSE_MIN_PX,
  composeDraft,
  composeFocused,
  composeIME,
  composeLive,
  finishComposeComposition,
  setComposeDraft,
  setComposeFocused,
  setComposeIME,
  setComposeLive as writeComposeLive,
} from "../compose-store";
import { markPaneSubmitted } from "../../dashboard/catalog-store";
import { clearNotice, clearNoticeForScope, captureNoticeScope, noticeScopeIsCurrent, showError, showStatus } from "../../../app/notices-store";
import { setPaneComposeLive } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { messageOf } from "../../../lib/notices";
import { currentDaemonId, liveSession } from "../../computers/catalog-store";
import { currentScreen } from "../../../app/navigation-store";
import { isAgentChat, isFullTerminal, livePaneHash, openPaneId } from "../session-store";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { type ComposeDraftScope, type ComposeInputMode } from "../../../lib/compose-draft-scope";
import { guardedReply } from "../../../lib/guarded";
import { t } from "../../../lib/i18n";
import { fitOperationPrompt } from "../../../lib/operations";
import { type NoticeScope } from "../../../lib/notice-scope";
import { type LiveSession } from "../../../lib/protocol/client";
import { ProtocolError } from "../../../lib/protocol/errors";
import { reconcileAmbiguousMutation, reportMutationError } from "../../connection/mutations";
import { requestPaneRefresh } from "../../connection/refresh-request";
import { commitView } from "../../../app/host";
import { nextDraftRevision, parkStoredDraft, readStoredDraft, writeStoredDraft } from "../drafts/state-drafts";
import { composeDraftMode } from "../model";
import { predictText } from "./echo";
import { flushKeys, queueKey } from "./keys";
import { LiveInputPump } from "./live-input";

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
  // Resolved at call time: importing this controller must not require #app.
  const app = appRoot();
  return app.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")
    || app.querySelector<HTMLTextAreaElement>(".dock-form textarea");
}

function focusComposeField(field: HTMLTextAreaElement): void {
  setComposeFocused(true);
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
  return composeIME() || composeFocused() || Boolean(composeDraft()) || Boolean(liveInputText());
}

const LIVE_PREVIEW_CHARS = 80;

let liveInputPump: LiveInputPump | null = null;
let liveInputSession: LiveSession | null = null;
let liveInputPane = "";
let submitBusy = false;

function reapStaleLiveInputPump(): void {
  if (liveInputPump && (liveInputSession !== liveSession() || liveInputPane !== openPaneId())) {
    liveInputPump.stop();
    liveInputPump = null;
    liveInputSession = null;
    liveInputPane = "";
  }
}

function liveInputVisible(): string {
  if (liveInputSession !== liveSession() || liveInputPane !== openPaneId()) return "";
  return liveInputPump?.snapshot().visibleText ?? "";
}

function liveInputText(): string {
  reapStaleLiveInputPump();
  return liveInputVisible();
}

export type ComposeViewSnapshot = {
  live: boolean;
  pendingText: string;
  draft: string;
  submitBusy: boolean;
};

const composeListeners = new Set<() => void>();
let composeSnap: ComposeViewSnapshot = { live: false, pendingText: "", draft: "", submitBusy: false };

export function subscribeComposeView(onStoreChange: () => void): () => void {
  composeListeners.add(onStoreChange);
  return () => { composeListeners.delete(onStoreChange); };
}

export function composeViewSnapshot(): ComposeViewSnapshot {
  const next: ComposeViewSnapshot = {
    live: composeLive(),
    pendingText: liveInputVisible(),
    draft: composeDraft(),
    submitBusy,
  };
  const prev = composeSnap;
  if (
    prev.live === next.live
    && prev.pendingText === next.pendingText
    && prev.draft === next.draft
    && prev.submitBusy === next.submitBusy
  ) return prev;
  composeSnap = next;
  return next;
}

function notifyComposeView(): void {
  composeViewSnapshot();
  for (const listener of composeListeners) listener();
}

export function liveInputPreview(text: string): string {
  const safe = text
    .replace(/\r\n?|\n/g, "↵")
    .replace(/\t/g, "⇥")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "·");
  const chars = Array.from(safe);
  return chars.length > LIVE_PREVIEW_CHARS ? `…${chars.slice(-LIVE_PREVIEW_CHARS).join("")}` : safe;
}

function syncLiveInputFeedback(): void {
  notifyComposeView();
}

function stopLiveInputPump(): void {
  liveInputPump?.stop();
  liveInputPump = null;
  liveInputSession = null;
  liveInputPane = "";
  syncLiveInputFeedback();
  notifyComposeView();
}

function restoreLiveInput(text: string, paneId: string): void {
  if (!text || openPaneId() !== paneId) return;
  const field = composeField();
  const current = field?.value ?? composeDraft();
  setComposeDraft(fitOperationPrompt(text + current).text);
  if (!field) return;
  field.value = composeDraft();
  sizeCompose(field);
  syncSendButton();
}

function ensureLiveInputPump(): LiveInputPump | null {
  const session = liveSession();
  const paneId = openPaneId();
  if (!session || !paneId) return null;
  if (liveInputPump && liveInputSession === session && liveInputPane === paneId) return liveInputPump;
  stopLiveInputPump();

  let pump!: LiveInputPump;
  pump = new LiveInputPump({
    schedule: (run) => window.requestAnimationFrame(() => run()),
    cancel: (handle) => window.cancelAnimationFrame(handle as number),
    send: (text) => {
      if (liveSession() !== session || openPaneId() !== paneId || !composeLive()) {
        return Promise.reject(new ProtocolError("conflict", t("err.liveTarget")));
      }
      const request = session.sendText(paneId, text);
      void request.then(() => {
        if (liveSession() === session && openPaneId() === paneId) clearNotice();
      }, () => undefined);
      return request;
    },
    // The mutation frame is already on the ordered socket when this runs.
    requestRead: () => { void requestPaneRefresh(); },
    onChange: () => {
      if (liveInputPump === pump) syncLiveInputFeedback();
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
      if (openPaneId() === paneId) writeComposeLive(false);
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
  predictText(openPaneId(), accepted, livePaneHash());
  return true;
}

export async function flushLiveInput(): Promise<boolean> {
  return liveInputPump ? liveInputPump.flush() : true;
}

/**
 * Identity of the pane that owns a live field when its text is transferred.
 * `setComposeDraft("")` inside the transfer publishes synchronously, and a
 * subscriber can replace the pane (switchComposeView) before the transfer
 * resumes. Carrying this identity lets the continuation recheck the owner
 * instead of enqueueing the retired field's text into the replacement.
 */
type LiveComposeOwner = {
  session: LiveSession | null;
  paneId: string;
  incarnation: number;
  daemonId: string | null;
  mode: ComposeInputMode;
};

function liveOwnerMoved(owner: LiveComposeOwner): boolean {
  return (
    liveSession() !== owner.session
    || openPaneId() !== owner.paneId
    || currentViewIncarnation() !== owner.incarnation
  );
}

/**
 * The owner pane was replaced while its live field's text was being
 * transferred. The text belongs to the pane that owned the field, never to
 * the replacement now on screen: park it in that pane's stored draft so
 * returning to the pane restores it, without sending anything or touching
 * the replacement's visible draft. The park mark keeps the replacement's
 * next empty-draft capture from erasing this text before it is ever shown.
 */
function parkLiveComposeText(text: string, owner: LiveComposeOwner): void {
  const fitted = fitOperationPrompt(text).text;
  if (!fitted) return;
  const scope: ComposeDraftScope = {
    daemonId: owner.daemonId,
    paneId: owner.paneId,
    mode: owner.mode,
  };
  const merged = fitOperationPrompt(fitted + readStoredDraft(scope).text).text;
  if (!merged) return;
  writeStoredDraft(scope, { text: merged, revision: nextDraftRevision() });
  parkStoredDraft(scope);
}

function takeLiveField(input: HTMLTextAreaElement): void {
  const owner: LiveComposeOwner = {
    session: liveSession(),
    paneId: openPaneId(),
    incarnation: currentViewIncarnation(),
    daemonId: currentDaemonId(),
    mode: composeDraftMode({ agentChat: isAgentChat(), fullTerminal: isFullTerminal() }),
  };
  const text = input.value;
  input.value = "";
  setComposeDraft("");
  sizeCompose(input);
  syncSendButton();
  if (!text) return;
  // The draft-clear publication above can synchronously replace the pane.
  // Recheck before enqueue or restore so this retired field's continuation
  // can never target the replacement pane.
  if (liveOwnerMoved(owner)) {
    parkLiveComposeText(text, owner);
    return;
  }
  if (!typeLive(text)) restoreLiveInput(text, owner.paneId);
}

export function syncComposeMode(): void {
  notifyComposeView();
}

export async function setComposeLive(on: boolean): Promise<void> {
  if (composeLive() === on) {
    syncComposeMode();
    return;
  }
  const paneId = openPaneId();
  const session = liveSession();
  if (paneId) setPaneComposeLive(paneId, on);
  if (composeLive()) {
    await flushLiveInput();
    if (openPaneId() !== paneId || liveSession() !== session) return;
    stopLiveInputPump();
    writeComposeLive(false);
  } else {
    const draft = composeDraft();
    clearComposeDraft();
    writeComposeLive(true);
    if (draft) typeLive(draft);
    await flushLiveInput();
    if (openPaneId() !== paneId || liveSession() !== session) return;
  }
  syncComposeMode();
}

/**
 * The dock action is always Enter. Empty Enter is a deliberate PTY keypress,
 * including when an agent's own TUI is asking for confirmation.
 */
export function syncSendButton(): void {
  notifyComposeView();
}

function clearComposeDraft(): void {
  setComposeDraft("");
  const field = composeField();
  if (!field) return;
  field.value = "";
  sizeCompose(field);
  syncSendButton();
}

/** Soft keyboards have no Shift+Enter, so newlines need their own affordance. */
export function insertNewline(): void {
  if (composeLive()) {
    void flushLiveInput().then((sent) => {
      if (sent) queueKey("enter");
    });
    return;
  }
  const field = composeField();
  if (!field) {
    setComposeDraft(composeDraft() + "\n");
    return;
  }
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText("\n", start, end, "end");
  setComposeDraft(field.value);
  sizeCompose(field);
  syncSendButton();
  focusComposeField(field);
  haptic(4);
}

export function insertCompose(text: string): void {
  if (composeLive()) {
    typeLive(text);
    return;
  }
  const field = composeField();
  const addition = composeDraft() && !composeDraft().endsWith(" ") ? ` ${text}` : text;
  if (!field) {
    setComposeDraft(fitOperationPrompt(composeDraft() + addition).text);
    return;
  }
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(addition, start, end, "end");
  setComposeDraft(fitOperationPrompt(field.value).text);
  field.value = composeDraft();
  sizeCompose(field);
  syncSendButton();
  focusComposeField(field);
}

/** Replace the draft with a slash token. Does not send Enter. */
export function setComposeText(text: string): void {
  if (composeLive()) {
    typeLive(text);
    return;
  }
  const next = fitOperationPrompt(text).text;
  setComposeDraft(next);
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

const RETRYABLE_GUARDED_READ = new Set(["backpressure", "daemon_replaced", "disconnected", "reconnecting", "timeout", "unbound"]);

async function guardedSubmit(
  session: LiveSession,
  paneId: string,
  text: string,
  noticeScope: NoticeScope,
  incarnation: number,
): Promise<"sent" | "stalled" | "cancelled"> {
  const isActive = () => liveSession() === session && currentViewIncarnation() === incarnation
    && currentScreen() === "pane" && openPaneId() === paneId && noticeScopeIsCurrent(noticeScope);
  return guardedReply({
    text,
    isActive,
    sendText: async (value) => {
      await session.sendText(paneId, value);
      if (isActive() && composeDraft() === value) clearComposeDraft();
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
  if (composeLive()) {
    if (!allowBareEnter) return;
    await submitLiveEnter();
    return;
  }
  const session = liveSession();
  if (!session || !openPaneId() || submitBusy) return;
  const paneId = openPaneId();
  const text = composeDraft();
  if (!text.trim()) {
    if (allowBareEnter) queueKey("enter");
    return;
  }
  submitBusy = true;
  syncSendButton();
  const noticeScope = captureNoticeScope();
  const incarnation = currentViewIncarnation();
  const ownsSubmit = () => liveSession() === session && currentViewIncarnation() === incarnation && noticeScopeIsCurrent(noticeScope);
  try {
    await flushKeys();
    const outcome = await guardedSubmit(session, paneId, text, noticeScope, incarnation);
    if (!ownsSubmit()) return;
    if (outcome === "cancelled") {
      clearNoticeForScope(noticeScope);
      return;
    }
    if (outcome === "stalled") {
      if (liveSession() === session && noticeScopeIsCurrent(noticeScope)) {
        showError(stallNotice(), noticeScope, true);
        commitView();
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
    await reconcileAmbiguousMutation(session, error, undefined, ownsSubmit);
    if (ownsSubmit()) {
      showError(messageOf(error), noticeScope);
      commitView();
    }
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
  if (event.isComposing || composeIME()) return;
  // Tab is how a keyboard reaches the chrome and the dock at all, and the pane
  // opens with focus on the body. Only the compose field keeps Tab for TUI
  // completion, and never with Shift, so focus can always back out.
  if (event.key === "Tab" && (!fromField || event.shiftKey)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitTyped(true);
    return;
  }
  if (event.key === "Backspace" && fromField && !composeDraft()) {
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
      if (composeLive()) {
        typeLive(event.key);
        return;
      }
      const next = fitOperationPrompt(composeDraft() + event.key).text;
      if (next === composeDraft()) return;
      setComposeDraft(next);
      const field = composeField();
      if (field) {
        field.value = composeDraft();
        focusComposeField(field);
        field.setSelectionRange(composeDraft().length, composeDraft().length);
        sizeCompose(field);
      }
    }
    return;
  }
  if (fromField && composeDraft() && event.key.startsWith("Arrow")) return;
  event.preventDefault();
  queueKey(special);
}

export function bindTermField(input: HTMLTextAreaElement): () => void {
  reapStaleLiveInputPump();
  setComposeDraft(fitOperationPrompt(composeDraft()).text);
  input.value = composeDraft();
  sizeCompose(input);
  let blurTimer: number | null = null;
  const onInput = () => {
    if (composeLive()) {
      if (composeIME()) {
        setComposeDraft(input.value);
        sizeCompose(input);
        return;
      }
      takeLiveField(input);
      return;
    }
    setComposeDraft(fitOperationPrompt(input.value).text);
    input.value = composeDraft();
    sizeCompose(input);
    syncSendButton();
  };
  const onCompositionStart = () => {
    setComposeIME(true);
  };
  const onCompositionEnd = () => {
    const session = liveSession();
    const paneId = openPaneId();
    const incarnation = currentViewIncarnation();
    const ownerMoved = () =>
      liveSession() !== session || openPaneId() !== paneId || currentViewIncarnation() !== incarnation;
    if (composeLive()) {
      setComposeIME(false);
      if (ownerMoved() || !input.isConnected) return;
      takeLiveField(input);
      return;
    }
    finishComposeComposition(fitOperationPrompt(input.value).text);
    if (ownerMoved() || !input.isConnected) return;
    input.value = composeDraft();
    sizeCompose(input);
    syncSendButton();
  };
  const onFocus = () => {
    setComposeFocused(true);
  };
  const onBlur = () => {
    blurTimer = window.setTimeout(() => {
      blurTimer = null;
      if (document.activeElement !== composeField()) setComposeFocused(false);
    }, 0);
  };
  const onKeyDown = (event: KeyboardEvent) => handlePaneKey(event, true);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKeyDown);
  return () => {
    if (blurTimer !== null) window.clearTimeout(blurTimer);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("compositionend", onCompositionEnd);
    input.removeEventListener("focus", onFocus);
    input.removeEventListener("blur", onBlur);
    input.removeEventListener("keydown", onKeyDown);
  };
}
