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

export function submitFullTerminalCompose(
  text: string,
  enter: boolean,
  ready: boolean,
  send: (data: Uint8Array) => void,
): boolean {
  if (!ready) return false;
  send(new TextEncoder().encode(enter ? `${text}\r` : text));
  return true;
}

function sizeField(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
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
    if (state.composeIME) return;
    sync();
    if (!send(state.composeDraft, true)) return;
    state.composeDraft = "";
    input.value = "";
    sizeField(input);
    sendButton.setAttribute("aria-label", t("compose.enterAria"));
    haptic(8);
  };

  input.addEventListener("input", () => {
    if (state.composeIME) {
      state.composeDraft = input.value;
      sizeField(input);
      return;
    }
    sync();
  });
  input.addEventListener("compositionstart", () => {
    state.composeIME = true;
  });
  input.addEventListener("compositionend", () => {
    state.composeIME = false;
    sync();
  });
  input.addEventListener("focus", () => {
    state.composeFocused = true;
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== input) state.composeFocused = false;
    }, 0);
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || state.composeIME || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
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
      pad.querySelector<HTMLFormElement>(".full-terminal-compose-form")?.requestSubmit();
      return;
    }
    options.sendKey(key);
  };
  pad = fullTerminalPad(routeKey, state.composeLive ? options.keyboard : undefined);
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
