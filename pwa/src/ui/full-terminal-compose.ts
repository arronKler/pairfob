import { node } from "../lib/dom";
import { t } from "../lib/i18n";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../lib/operations";
import {
  COMPOSE_MAX_PX,
  COMPOSE_MIN_PX,
  haptic,
  setPaneComposeLive,
  state,
} from "../state";
import { fullTerminalPad, syncKeyboardButton } from "./full-terminal-input";

type TerminalKeyboardControl = {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
};

export type FullTerminalControlsOptions = {
  sendKey: (key: string) => void;
  sendCompose: (text: string, enter: boolean) => boolean;
  keyboard: TerminalKeyboardControl;
  desk: boolean;
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
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
}

function setComposeText(root: ParentNode, text: string): void {
  const next = fitOperationPrompt(text).text;
  state.composeDraft = next;
  const input = root.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input");
  if (!input) return;
  input.value = next;
  sizeField(input);
  const send = root.querySelector<HTMLButtonElement>(".full-terminal-compose-send");
  send?.setAttribute("aria-label", next.trim() ? t("compose.sendEnterAria") : t("compose.enterAria"));
  input.focus();
  input.setSelectionRange(next.length, next.length);
  haptic(4);
}

function composeForm(send: FullTerminalControlsOptions["sendCompose"]): HTMLFormElement {
  const form = node("form", "full-terminal-compose-form");
  const label = node("label", "sr-only", t("compose.batchAria"));
  const input = node("textarea", "full-terminal-compose-input");
  const sendButton = node("button", "full-terminal-compose-send", "Enter");
  const inputID = "full-terminal-compose";
  label.htmlFor = inputID;
  input.id = inputID;
  input.name = "pairfob-full-terminal-compose";
  input.rows = 1;
  input.wrap = "soft";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "none";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.placeholder = t("compose.batchPh");
  input.enterKeyHint = "enter";
  input.maxLength = OPERATION_INPUT_LIMITS.prompt;
  state.composeDraft = fitOperationPrompt(state.composeDraft).text;
  input.value = state.composeDraft;
  sizeField(input);
  sendButton.type = "submit";
  sendButton.setAttribute(
    "aria-label",
    state.composeDraft.trim() ? t("compose.sendEnterAria") : t("compose.enterAria"),
  );
  let enterPolicy: ComposeEnterPolicyState = {
    ...INITIAL_COMPOSE_ENTER_POLICY,
    composing: state.composeIME,
  };
  let deferredSubmitQueued = false;
  let explicitPadEnter = false;

  const sync = (): void => {
    state.composeDraft = fitOperationPrompt(input.value).text;
    input.value = state.composeDraft;
    sizeField(input);
    sendButton.setAttribute(
      "aria-label",
      state.composeDraft.trim() ? t("compose.sendEnterAria") : t("compose.enterAria"),
    );
  };
  const submit = (): void => {
    sync();
    if (!send(state.composeDraft, true)) return;
    state.composeDraft = "";
    input.value = "";
    sizeField(input);
    sendButton.setAttribute("aria-label", t("compose.enterAria"));
    haptic(8);
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
      deferredSubmitQueued = false;
      if (enterPolicy.composing) return;
      submit();
      if (releaseEnterGate) transition({ type: "keyup", enter: true });
    });
  };
  const finishComposition = (): void => {
    const releaseEnterGate = explicitPadEnter;
    explicitPadEnter = false;
    state.composeIME = false;
    sync();
    if (transition({ type: "compositionend" }) === "submit") {
      deferSubmitUntilCompositionSettles(releaseEnterGate);
    }
  };
  padComposeSubmitters.set(form, () => {
    explicitPadEnter = true;
    input.blur();
    form.requestSubmit();
    if (!enterPolicy.composing) {
      explicitPadEnter = false;
      return;
    }
    // Screen keys prevent their pointerdown default, so some IMEs never emit
    // compositionend. Commit the textarea's current value instead of hanging.
    queueMicrotask(() => {
      if (enterPolicy.composing && enterPolicy.pendingSubmit) finishComposition();
    });
  });

  input.addEventListener("input", () => {
    if (enterPolicy.composing) {
      state.composeDraft = input.value;
      sizeField(input);
      return;
    }
    sync();
  });
  input.addEventListener("compositionstart", () => {
    state.composeIME = true;
    transition({ type: "compositionstart" });
  });
  input.addEventListener("compositionend", finishComposition);
  input.addEventListener("focus", () => {
    state.composeFocused = true;
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== input) state.composeFocused = false;
    }, 0);
  });
  input.addEventListener("keydown", (event) => {
    const action = transition({
      type: "keydown",
      enter: event.key === "Enter",
      shift: event.shiftKey,
      isComposing: event.isComposing,
    });
    if (action === "pass" || action === "defer") return;
    event.preventDefault();
    if (action === "submit") submit();
  });
  input.addEventListener("keyup", (event) => {
    transition({ type: "keyup", enter: event.key === "Enter" });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (deferredSubmitQueued) return;
    if (transition({ type: "submit" }) === "submit") submit();
  });
  form.append(label, input, sendButton);
  return form;
}

export function syncFullTerminalControls(root: HTMLElement, options: FullTerminalControlsOptions): void {
  const mode = state.composeLive ? "live" : "compose";
  const current = root.querySelector<HTMLElement>(".full-terminal-pad");
  if (current?.dataset.inputMode === mode) {
    syncKeyboardButton(current, options.keyboard.isOpen());
    return;
  }
  if (state.composeLive) {
    if (options.desk) options.keyboard.open();
  } else {
    options.keyboard.close();
  }
  let pad!: HTMLElement;
  const routeKey = (key: string): void => {
    if (!state.composeLive && key === "enter") {
      const form = pad.querySelector<HTMLFormElement>(".full-terminal-compose-form");
      if (form) padComposeSubmitters.get(form)?.();
      return;
    }
    options.sendKey(key);
  };
  const selectCommand = (text: string): void => {
    if (state.composeLive) {
      options.sendCompose(text, false);
      return;
    }
    setComposeText(pad, text);
  };
  pad = fullTerminalPad(routeKey, state.composeLive ? options.keyboard : undefined, selectCommand);
  pad.dataset.inputMode = mode;
  if (!state.composeLive) pad.append(composeForm(options.sendCompose));
  if (current) current.replaceWith(pad);
  else root.append(pad);
}

export function setFullTerminalInputMode(
  live: boolean,
  sendCompose: FullTerminalControlsOptions["sendCompose"],
  repaint: () => void,
): void {
  if (state.composeLive === live) {
    repaint();
    return;
  }
  if (state.paneId) setPaneComposeLive(state.paneId, live);
  if (live && state.composeDraft && sendCompose(state.composeDraft, false)) state.composeDraft = "";
  state.composeLive = live;
  repaint();
}
