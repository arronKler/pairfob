import { t } from "../../../lib/i18n";
import { fitOperationPrompt } from "../../../lib/operations";
import {
  composeDraft,
  composeFocused,
  composeIME,
  composeLive,
  finishComposeComposition,
  setComposeDraft,
  setComposeFocused,
  setComposeIME,
  setComposeLive,
} from "../compose-store";
import { openPaneId } from "../session-store";
import { setPaneComposeLive } from "../../settings/preferences-store";
import { haptic } from "../../../lib/dom";
import { showError } from "../../../app/notices-store";
import { fitComposeHeight } from "../compose-size";
import { returnAddsNewline, withQuickCommand, withSlashCommand } from "../compose-keys";
import { acceptComposePaste, attachmentMessage, markSentAttachments, requestSend } from "../guided/send-gate";

export type TerminalKeyboardControl = {
  toggle: () => void;
  /** Hand xterm the keys, and the caret too unless `take` is false (another column or a dialog has it). */
  open: (take?: boolean) => void;
  close: () => void;
  isOpen: () => boolean;
};

export type FullTerminalControlsOptions = {
  sendKey: (key: string) => void;
  sendCompose: (text: string, enter: boolean) => boolean;
  keyboard: TerminalKeyboardControl;
  /** Keys reach the page without an on-screen keyboard, so live input goes straight to xterm. */
  hardwareKeyboard: boolean;
  /** Switch 组字 / 实时 through the controller, which also republishes the terminal view. */
  setLive?: (live: boolean) => void;
  /** Copy what is selected in the terminal; false when nothing is (see full-terminal-copy). */
  copySelection?: () => boolean;
};

export type ComposeEnterPolicyState = Readonly<{
  composing: boolean;
  pendingSubmit: boolean;
  suppressUntilEnterUp: boolean;
}>;

export type ComposeEnterPolicyEvent =
  | Readonly<{ type: "compositionstart" }>
  | Readonly<{ type: "compositionend" }>
  | Readonly<{ type: "submit" }>
  | Readonly<{
      type: "keydown";
      enter: boolean;
      shift: boolean;
      isComposing: boolean;
    }>
  | Readonly<{ type: "keyup"; enter: boolean }>;

export type ComposeEnterPolicyAction = "pass" | "defer" | "submit" | "suppress";

const padComposeSubmitters = new WeakMap<HTMLFormElement, () => void>();

/** Explicit pad Enter with an IME composition fallback. */
export function requestFullTerminalPadEnter(root: ParentNode): void {
  const form = root.querySelector<HTMLFormElement>(".full-terminal-compose-form");
  if (form) padComposeSubmitters.get(form)?.();
}

export const INITIAL_COMPOSE_ENTER_POLICY: ComposeEnterPolicyState = {
  composing: false,
  pendingSubmit: false,
  suppressUntilEnterUp: false,
};

export function reduceComposeEnterPolicy(
  current: ComposeEnterPolicyState,
  event: ComposeEnterPolicyEvent,
): Readonly<{ state: ComposeEnterPolicyState; action: ComposeEnterPolicyAction }> {
  if (event.type === "compositionstart") {
    return {
      state: { composing: true, pendingSubmit: false, suppressUntilEnterUp: false },
      action: "pass",
    };
  }
  if (event.type === "compositionend") {
    return {
      state: {
        composing: false,
        pendingSubmit: false,
        suppressUntilEnterUp: current.pendingSubmit,
      },
      action: current.pendingSubmit ? "submit" : "pass",
    };
  }
  if (event.type === "keyup") {
    if (!event.enter) return { state: current, action: "pass" };
    return {
      state: { ...current, suppressUntilEnterUp: false },
      action: "pass",
    };
  }
  if (event.type === "submit") {
    if (current.composing) {
      return {
        state: { ...current, pendingSubmit: true },
        action: "defer",
      };
    }
    if (current.suppressUntilEnterUp) return { state: current, action: "suppress" };
    return { state: current, action: "submit" };
  }
  if (!event.enter || event.shift) return { state: current, action: "pass" };
  if (current.suppressUntilEnterUp) return { state: current, action: "suppress" };
  if (current.composing || event.isComposing) {
    return {
      state: { ...current, pendingSubmit: true },
      action: "defer",
    };
  }
  // WebKit can end composition before delivering the Enter keydown. In that
  // ordering this is a normal submit; the keyup gate still prevents repeats.
  return {
    state: { ...current, suppressUntilEnterUp: true },
    action: "submit",
  };
}

export function submitFullTerminalCompose(
  text: string,
  enter: boolean,
  ready: boolean,
  send: (data: Uint8Array, options?: { isolate?: boolean }) => void,
): boolean {
  if (!ready) return false;
  if (text) send(new TextEncoder().encode(text));
  // Keep Enter as its own terminal command. Some TUIs treat a text payload
  // ending in CR as pasted input instead of a deliberate Enter key press.
  if (enter) send(new Uint8Array([0x0d]), { isolate: true });
  return true;
}

function sizeField(field: HTMLTextAreaElement): void {
  fitComposeHeight(field);
}

/**
 * Write the draft and its ready attachment paths (draft, blank line, one path
 * per line) followed by Enter. False when nothing was delivered.
 */
function deliverMessage(paths: readonly string[], send: (text: string, enter: boolean) => boolean): boolean {
  const draft = composeDraft();
  const text = attachmentMessage(draft, paths);
  if (fitOperationPrompt(text).truncated) {
    showError(t("compose2.tooLong"));
    return false;
  }
  if (!send(text, true)) return false;
  if (composeDraft() === draft) setComposeDraft("");
  if (paths.length) markSentAttachments();
  haptic(8);
  return true;
}

/**
 * Live input has no send button and its Enter goes straight to the PTY, so
 * attachments are sent the way guided live input sends them: back to 组字
 * first (paths typed live would press Enter at every newline), then through
 * the same wait / blocked checks as the batch field.
 */
export function sendFullTerminalAttachments(
  sendCompose: FullTerminalControlsOptions["sendCompose"],
  repaint: () => void,
): void {
  setFullTerminalInputMode(false, sendCompose, repaint);
  void requestSend((paths) => { deliverMessage(paths, sendCompose); });
}

export type FullTerminalComposeFeedback = {
  draft: string;
};

export type FullTerminalComposeOptions = {
  /** A phone keyboard's Return adds a line instead of sending (see compose-keys). */
  phoneField?: () => boolean;
};

const padComposeBindings = new WeakMap<HTMLFormElement, () => void>();

function setComposeText(root: ParentNode, text: string, tap = true): void {
  const next = fitOperationPrompt(text).text;
  setComposeDraft(next);
  const input = root.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input");
  if (!input) return;
  input.value = next;
  sizeField(input);
  const EventCtor = input.ownerDocument.defaultView?.Event;
  if (EventCtor) input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  input.focus({ preventScroll: true });
  input.setSelectionRange(next.length, next.length);
  if (tap) haptic(4);
}

/**
 * A key typed with the terminal or the page focused joins the draft and moves
 * the caret into the field, as the guided session does.
 */
export function typeIntoFullTerminalCompose(root: ParentNode, text: string): void {
  setComposeText(root, composeDraft() + text, false);
}

/**
 * Command pad contract for the full terminal (session page v2), matching the
 * guided `insertSlashCommand`: the token goes before the draft, replacing a
 * leading slash command; live input writes it to the terminal without Enter.
 */
export function insertFullTerminalSlashCommand(
  root: ParentNode,
  token: string,
  sendCompose: FullTerminalControlsOptions["sendCompose"],
): void {
  if (composeLive()) {
    sendCompose(token, false);
    return;
  }
  setComposeText(root, withSlashCommand(composeDraft(), token));
}

/** A saved command goes in at the caret of the batch field (an empty draft is filled). */
export function insertFullTerminalQuickCommand(root: ParentNode, text: string): void {
  const input = root.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input");
  const draft = input?.value ?? composeDraft();
  const { next, caret } = withQuickCommand(draft, input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length, text);
  setComposeText(root, next);
  const fitted = input?.value.length ?? 0;
  input?.setSelectionRange(Math.min(caret, fitted), Math.min(caret, fitted));
}

/**
 * Controller-owned field/form: value, height, IME reducer, pad Enter, microtask
 * submit. Idempotent: a second bind on the same form disposes the first.
 */
export function bindFullTerminalCompose(
  field: HTMLTextAreaElement,
  form: HTMLFormElement,
  send: (text: string, enter: boolean) => boolean,
  feedback?: (next: FullTerminalComposeFeedback) => void,
  options: FullTerminalComposeOptions = {},
): () => void {
  padComposeBindings.get(form)?.();
  const sendButton = form.querySelector<HTMLButtonElement>(".full-terminal-compose-send");
  let alive = true;
  let blurTimer: number | null = null;
  let enterPolicy: ComposeEnterPolicyState = {
    ...INITIAL_COMPOSE_ENTER_POLICY,
    composing: composeIME(),
  };
  let deferredSubmitQueued = false;
  let explicitPadEnter = false;

  const publish = (): void => {
    const draft = composeDraft();
    feedback?.({ draft });
    if (feedback || !sendButton) return;
    sendButton.setAttribute(
      "aria-label",
      draft.trim() ? t("compose.sendEnterAria") : t("compose.enterAria"),
    );
  };
  const sync = (): void => {
    setComposeDraft(fitOperationPrompt(field.value).text);
    field.value = composeDraft();
    sizeField(field);
    publish();
  };
  const submitMessage = (paths: readonly string[]): void => {
    if (!alive || !deliverMessage(paths, send)) return;
    field.value = composeDraft();
    sizeField(field);
    publish();
  };
  // Ready attachments ride with the text; running uploads make the send wait.
  const submit = (): void => {
    if (!alive) return;
    sync();
    void requestSend(submitMessage);
  };
  const transition = (event: ComposeEnterPolicyEvent): ComposeEnterPolicyAction => {
    const result = reduceComposeEnterPolicy(enterPolicy, event);
    enterPolicy = result.state;
    return result.action;
  };
  const deferSubmitUntilCompositionSettles = (releaseEnterGate = false): void => {
    if (deferredSubmitQueued) return;
    deferredSubmitQueued = true;
    // Firefox may deliver the final input immediately after compositionend,
    // while Chromium updates the value before it. A microtask observes either
    // ordering without relying on a timer or sending the unfinished candidate.
    queueMicrotask(() => {
      if (!alive) return;
      deferredSubmitQueued = false;
      if (enterPolicy.composing) return;
      submit();
      if (releaseEnterGate) transition({ type: "keyup", enter: true });
    });
  };
  const finishComposition = (): void => {
    if (!alive) return;
    const releaseEnterGate = explicitPadEnter;
    explicitPadEnter = false;
    // Publish IME completion and the fitted final text in ONE coherent write
    // (subscribers see both together, as compose does for its own field). A
    // subscriber can then retire this binding and replace the pane, so recheck
    // the exact retired binding before any field/feedback/send/draft effect:
    // the dragged old value must never land in the replacement's draft.
    finishComposeComposition(fitOperationPrompt(field.value).text);
    if (!alive) return;
    field.value = composeDraft();
    sizeField(field);
    publish();
    if (transition({ type: "compositionend" }) === "submit") {
      deferSubmitUntilCompositionSettles(releaseEnterGate);
    }
  };

  const onInput = (): void => {
    if (enterPolicy.composing) {
      setComposeDraft(field.value);
      sizeField(field);
      feedback?.({ draft: composeDraft() });
      return;
    }
    sync();
  };
  const onCompositionStart = (): void => {
    setComposeIME(true);
    transition({ type: "compositionstart" });
  };
  const onFocus = (): void => {
    setComposeFocused(true);
  };
  const onBlur = (): void => {
    blurTimer = window.setTimeout(() => {
      blurTimer = null;
      if (!alive) return;
      if (document.activeElement !== field) setComposeFocused(false);
    }, 0);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    // Return adds a line on a phone; it never reaches the IME submit policy.
    if (returnAddsNewline(event, options.phoneField?.() === true)) return;
    const action = transition({
      type: "keydown",
      enter: event.key === "Enter",
      shift: event.shiftKey,
      isComposing: event.isComposing,
    });
    if (action === "pass" || action === "defer") return;
    event.preventDefault();
    if (action === "submit") submit();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    transition({ type: "keyup", enter: event.key === "Enter" });
  };
  const onSubmit = (event: Event): void => {
    event.preventDefault();
    if (!alive || deferredSubmitQueued) return;
    if (transition({ type: "submit" }) === "submit") submit();
  };
  const onSendPointerDown = (event: Event): void => {
    // An active IME still needs the native blur/commit sequence on submission.
    if (!composeIME()) event.preventDefault();
  };

  setComposeDraft(fitOperationPrompt(composeDraft()).text);
  field.value = composeDraft();
  sizeField(field);
  publish();

  padComposeSubmitters.set(form, () => {
    if (!alive) return;
    explicitPadEnter = true;
    if (enterPolicy.composing) field.blur();
    form.requestSubmit();
    if (!enterPolicy.composing) {
      explicitPadEnter = false;
      return;
    }
    // Screen keys prevent their pointerdown default, so some IMEs never emit
    // compositionend. Commit the textarea's current value instead of hanging.
    queueMicrotask(() => {
      if (!alive) return;
      if (enterPolicy.composing && enterPolicy.pendingSubmit) finishComposition();
    });
  });

  field.addEventListener("input", onInput);
  field.addEventListener("compositionstart", onCompositionStart);
  field.addEventListener("compositionend", finishComposition);
  field.addEventListener("focus", onFocus);
  field.addEventListener("blur", onBlur);
  field.addEventListener("keydown", onKeyDown);
  field.addEventListener("keyup", onKeyUp);
  field.addEventListener("paste", acceptComposePaste);
  form.addEventListener("submit", onSubmit);
  sendButton?.addEventListener("pointerdown", onSendPointerDown);

  const dispose = (): void => {
    if (!alive) return;
    alive = false;
    deferredSubmitQueued = false;
    explicitPadEnter = false;
    if (blurTimer !== null) window.clearTimeout(blurTimer);
    blurTimer = null;
    padComposeSubmitters.delete(form);
    field.removeEventListener("input", onInput);
    field.removeEventListener("compositionstart", onCompositionStart);
    field.removeEventListener("compositionend", finishComposition);
    field.removeEventListener("focus", onFocus);
    field.removeEventListener("blur", onBlur);
    field.removeEventListener("keydown", onKeyDown);
    field.removeEventListener("keyup", onKeyUp);
    field.removeEventListener("paste", acceptComposePaste);
    form.removeEventListener("submit", onSubmit);
    sendButton?.removeEventListener("pointerdown", onSendPointerDown);
    if (padComposeBindings.get(form) === dispose) padComposeBindings.delete(form);
  };
  padComposeBindings.set(form, dispose);
  return dispose;
}

export function setFullTerminalInputMode(
  live: boolean,
  sendCompose: FullTerminalControlsOptions["sendCompose"],
  repaint: () => void,
): void {
  if (composeLive() === live) {
    repaint();
    return;
  }
  const paneId = openPaneId();
  if (paneId) setPaneComposeLive(paneId, live);
  if (live && composeDraft() && sendCompose(composeDraft(), false)) setComposeDraft("");
  setComposeLive(live);
  repaint();
}
