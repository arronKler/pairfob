import { encodeLiveKey } from "../keypad/live-key";
import { appRoot } from "../../../app/dom-root";
import { hardwareKeyboard, macPlatform } from "../../../app/input-mode";
import {
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
import { liveSession } from "../../computers/catalog-store";
import { currentScreen } from "../../../app/navigation-store";
import { isAgentChat, isFullTerminal, livePaneHash, openPaneId, paneFollow } from "../session-store";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { guardedReply } from "../../../lib/guarded";
import { t } from "../../../lib/i18n";
import { fitOperationPrompt } from "../../../lib/operations";
import { type NoticeScope } from "../../../lib/notice-scope";
import { type LiveSession } from "../../../lib/protocol/client";
import { ProtocolError } from "../../../lib/protocol/errors";
import { reconcileAmbiguousMutation, reportMutationError } from "../../connection/mutations";
import { requestPaneRefresh } from "../../connection/refresh-request";
import { commitView } from "../../../app/host";
import { predictText } from "./echo";
import { flushKeys, queueKey, sendPage } from "./keys";
import { liveOrder, registerLivePath } from "./live-order";
import { termHasSelection } from "./term";
import { LiveInputPump } from "./live-input";
import { liveComposeOwner, liveOwnerMoved, parkLiveComposeText } from "./live-owner";
import { fitComposeHeight } from "../compose-size";
import { hardwareLiveKey } from "../keypad/hardware-keys";
import { returnAddsNewline, withQuickCommand, withSlashCommand, fieldKeepsControlChord } from "../compose-keys";
import { acceptComposePaste, attachmentMessage, markSentAttachments, requestSend } from "./send-gate";

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

/**
 * Hand the keyboard to the compose field without a tap on it: a session opened
 * from the board, or the input mode switched under the field. Only a keyboard
 * that is not on glass is handed anything. A field typed on glass waits for its
 * tap at every width, as it does when the list opens the session: focusing it
 * raises the keys over what the reader came to look at.
 */
export function focusCompose(): void {
  if (!hardwareKeyboard()) return;
  const field = composeField();
  if (!field) return;
  focusComposeField(field);
  const caret = field.value.length;
  field.setSelectionRange(caret, caret);
}

/**
 * Grow the field with its draft. The terminal above shrinks by the same amount,
 * so a reader following the tail stays on the tail.
 */
export function sizeCompose(field: HTMLTextAreaElement): void {
  if (!fitComposeHeight(field) || !paneFollow()) return;
  const term = appRoot().querySelector<HTMLElement>(".term");
  if (term) term.scrollTop = term.scrollHeight;
}

export function preserveCompose(): boolean {
  return composeIME() || composeFocused() || Boolean(composeDraft()) || Boolean(liveInputText());
}

const LIVE_PREVIEW_CHARS = 80;

let liveInputPump: LiveInputPump | null = null;
let liveInputSession: LiveSession | null = null;
let liveInputPane = "";
let submitBusy = false;

/**
 * Typed characters are one of the paths of the session's order (`live-order`):
 * what the pump holds behind a slow write keeps a later key waiting, and a key
 * still queued keeps a later character out of the pump.
 */
registerLivePath("text", {
  unsent: () => Boolean(liveInputPump?.snapshot().queuedText),
  written: () => liveInputPump?.written() ?? Promise.resolve(),
});
/** Characters that were waiting for their turn when the order was reset, oldest first. */
let droppedLiveText = "";

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
  liveOrder.reset();
  droppedLiveText = "";
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
  // A pump left from another pane goes, and what waited for it with it. With
  // none there is nothing to stop: a page key pressed before the first
  // character here keeps its place in the order.
  if (liveInputPump) stopLiveInputPump();

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
      // What was typed after the text that failed does not go on without it:
      // keys are dropped, characters go back to the draft behind what failed.
      liveOrder.reset();
      const waiting = droppedLiveText;
      droppedLiveText = "";
      if (liveInputPump === pump) {
        liveInputPump = null;
        liveInputSession = null;
        liveInputPane = "";
      }
      const restore = (error instanceof ProtocolError && error.code === "unknown_outcome"
        ? input.queuedText
        : input.failedText + input.queuedText) + waiting;
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
  if (!text || !ensureLiveInputPump()) return false;
  const paneId = openPaneId();
  let now = true;
  let accepted = true;
  liveOrder.submit("text", () => {
    accepted = writeLive(text);
    // Typed behind a key that was still waiting: the caller has gone on, so text that is refused goes back to the draft here.
    if (!accepted && !now) restoreLiveInput(text, paneId);
  }, () => { droppedLiveText += text; });
  now = false;
  return accepted;
}

function writeLive(text: string): boolean {
  const pump = ensureLiveInputPump();
  if (!pump) return false;
  const queued = pump.snapshot().queuedText;
  const next = fitOperationPrompt(queued + text).text;
  const accepted = next.startsWith(queued) ? next.slice(queued.length) : "";
  if (!accepted) return false;
  const bytes = encodeLiveKey(accepted);
  if (!pump.enqueue(accepted, bytes)) return false;
  haptic(4);
  if (bytes === accepted) predictText(openPaneId(), accepted, livePaneHash());
  return true;
}

/** Everything typed so far in live input has been written and acknowledged, or was refused (false). */
export function flushLiveInput(): Promise<boolean> {
  // What is still waiting for its turn has not reached the pump yet.
  if (liveOrder.waiting()) return liveOrder.drained().then(() => flushLiveInput());
  return liveInputPump ? liveInputPump.flush() : Promise.resolve(true);
}

function takeLiveField(input: HTMLTextAreaElement): void {
  const owner = liveComposeOwner();
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
    submitLiveEnter();
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

function placeInField(next: string, caret: number): void {
  setComposeDraft(next);
  const field = composeField();
  if (!field) return;
  field.value = next;
  sizeCompose(field);
  syncSendButton();
  focusComposeField(field);
  field.setSelectionRange(caret, caret);
  haptic(4);
}

/**
 * Contract for the command pad (session page v2). A slash command goes to the
 * start of the draft and keeps what was written after it — write the goal,
 * then tap /goal — and an existing leading slash command is replaced. Never
 * sends Enter.
 */
export function insertSlashCommand(token: string): void {
  if (composeLive()) {
    typeLive(token);
    return;
  }
  const next = fitOperationPrompt(withSlashCommand(composeDraft(), token)).text;
  placeInField(next, next.length);
}

/** Contract for the command pad: a saved command goes in at the caret; an empty draft is filled. */
export function insertQuickCommand(text: string): void {
  if (composeLive()) {
    typeLive(text);
    return;
  }
  const field = composeField();
  const draft = field?.value ?? composeDraft();
  const { next, caret } = withQuickCommand(draft, field?.selectionStart ?? draft.length, field?.selectionEnd ?? draft.length, text);
  const fitted = fitOperationPrompt(next).text;
  placeInField(fitted, Math.min(fitted.length, caret));
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
  message: { text: string; draft: string; attachments: boolean },
  noticeScope: NoticeScope,
  incarnation: number,
): Promise<"sent" | "stalled" | "cancelled"> {
  const isActive = () => liveSession() === session && currentViewIncarnation() === incarnation
    && currentScreen() === "pane" && openPaneId() === paneId && noticeScopeIsCurrent(noticeScope);
  return guardedReply({
    text: message.text,
    isActive,
    sendText: async (value) => {
      await session.sendText(paneId, value);
      if (!isActive()) return;
      // The text is in the terminal now: the draft and the attached paths it
      // carried must not be offered again, whether or not Enter follows.
      if (composeDraft() === message.draft) clearComposeDraft();
      if (message.attachments) markSentAttachments();
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

/** Enter in live input: a key like any other, written after the text typed before it (`liveOrder`). */
function submitLiveEnter(): void {
  queueKey("enter");
}

/**
 * Send the draft with its ready attachments. Uploads still running make the
 * send wait (see send-gate); an empty message is a deliberate bare Enter.
 */
export async function submitTyped(allowBareEnter = false): Promise<void> {
  await requestSend((paths) => submitMessage(paths, allowBareEnter));
}

async function submitMessage(paths: readonly string[], allowBareEnter: boolean): Promise<void> {
  if (composeLive()) {
    if (!paths.length) {
      if (allowBareEnter) submitLiveEnter();
      return;
    }
    // Paths cannot be typed live (their newlines would be Enter presses):
    // the message goes through the composed path instead.
    await setComposeLive(false);
    if (composeLive()) return;
  }
  const session = liveSession();
  if (!session || !openPaneId() || submitBusy) return;
  const paneId = openPaneId();
  const draft = composeDraft();
  const text = attachmentMessage(draft, paths);
  if (!text.trim()) {
    if (allowBareEnter) queueKey("enter");
    return;
  }
  if (fitOperationPrompt(text).truncated) {
    showError(t("compose2.tooLong"));
    return;
  }
  submitBusy = true;
  syncSendButton();
  const noticeScope = captureNoticeScope();
  const incarnation = currentViewIncarnation();
  const ownsSubmit = () => liveSession() === session && currentViewIncarnation() === incarnation && noticeScopeIsCurrent(noticeScope);
  try {
    await flushKeys();
    const outcome = await guardedSubmit(session, paneId, { text, draft, attachments: paths.length > 0 }, noticeScope, incarnation);
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

/** The browser's paste: Command+V, and Shift+Insert as terminals have it. */
function isPaste(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey) return false;
  return event.metaKey ? event.key.toLowerCase() === "v" && !event.shiftKey : event.key === "Insert" && event.shiftKey;
}

/**
 * A key for the session, pressed in its compose field (`fromField`) or on the
 * page. Composed: the field edits its draft, and Enter, Esc, the arrows and
 * Ctrl with a letter go to the program. Live input on a hardware keyboard: the
 * keyboard is the program's wherever in the session it is typed, with the bytes
 * a terminal sends (`hardwareLiveKey`); only F6 is taken before it gets here
 * (`app/column-keys`), and Command chords stay the browser's.
 */
export function handlePaneKey(event: KeyboardEvent, fromField: boolean): void {
  if (event.isComposing || composeIME()) return;
  const live = composeLive();
  const keyboard = live && hardwareKeyboard();
  // A paste pressed on the page lands where live input is typed, as it does in the complete terminal.
  if (keyboard && !fromField && isPaste(event)) focusCompose();
  // Live input: the keys the pad has no cap for go to the program too.
  const hardwareKey = keyboard ? hardwareLiveKey(event) : null;
  if (hardwareKey) {
    event.preventDefault();
    queueKey(hardwareKey);
    return;
  }
  // Composed, Tab is how a keyboard reaches the chrome and the dock at all, and
  // the pane opens with focus on the body. Only the compose field keeps Tab for
  // TUI completion, and never with Shift: Shift+Tab is the way back out of the
  // field (the key row has ⇧Tab for the program). With words in the draft there
  // is nothing in the terminal for a Tab to complete, so it leaves the field
  // like any other; an empty prompt sends it on. That last rule is a hardware
  // keyboard's: a phone keeps sending the field's Tab on, as it always has.
  if (event.key === "Tab" && (!fromField || event.shiftKey || (!live && composeDraft() && hardwareKeyboard()))) return;
  // PageUp / PageDown page the session, as the touch rail's buttons do. Only
  // from a hardware keyboard: a phone forwards neither, whatever reports them.
  if ((event.key === "PageUp" || event.key === "PageDown") && hardwareKeyboard()
    && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    void sendPage(event.key === "PageUp" ? "up" : "down");
    return;
  }
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
    // Ctrl+Shift with a letter is no terminal key: terminals keep it for copy and paste, browsers for their own.
    if (event.shiftKey && hardwareKeyboard()) return;
    const input = fromField ? composeField() : null;
    if (input && event.key.toLowerCase() === "c" && fieldHasSelection(input)) return;
    if (input && fieldKeepsControlChord(event.key, Boolean(composeDraft()))) return;
    // Text dragged out of the buffer: Ctrl+C copies it instead of interrupting.
    // On a Mac copying is Command+C, so there Control+C is always the program's.
    if (!fromField && event.key.toLowerCase() === "c" && termHasSelection() && !macPlatform()) return;
    event.preventDefault();
    queueKey(`ctrl+${event.key.toLowerCase()}`);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const special = SPECIAL_KEYS[event.key];
  if (!special || event.key === "Enter" || event.key === "Backspace") {
    if (!fromField && event.key.length === 1) {
      event.preventDefault();
      if (live) {
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
  const onKeyDown = (event: KeyboardEvent) => {
    // The phone field lets Return add a line; live input keeps Enter for the PTY.
    if (!composeLive() && returnAddsNewline(event, input.id === "compose-text-mobile")) return;
    handlePaneKey(event, true);
  };
  input.addEventListener("input", onInput);
  input.addEventListener("paste", acceptComposePaste);
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
    input.removeEventListener("paste", acceptComposePaste);
  };
}
