import type { ILink, ILinkProvider, ITerminalOptions, Terminal } from "@xterm/xterm";

import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { saveKeysExpanded, state } from "../state";
import { PRIMARY_KEYS, SECONDARY_KEYS, TERTIARY_KEYS, bindModifier, clearModifiers, paintKey, withModifiers, type KeySpec } from "./keypad";

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 90;

/** CSI / application-cursor bytes a TUI expects from a hardware key. */
export function encodeTerminalKey(key: string, applicationCursor = false): string {
  switch (key) {
    case "esc":
      return "\x1b";
    case "up":
      return applicationCursor ? "\x1bOA" : "\x1b[A";
    case "down":
      return applicationCursor ? "\x1bOB" : "\x1b[B";
    case "right":
      return applicationCursor ? "\x1bOC" : "\x1b[C";
    case "left":
      return applicationCursor ? "\x1bOD" : "\x1b[D";
    case "backspace":
      return "\x7f";
    case "tab":
      return "\t";
    case "enter":
      return "\r";
    default: {
      const ctrl = /^ctrl\+([a-z])$/.exec(key);
      if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
      if (key.length === 1) return key;
      return "";
    }
  }
}

export function httpUrlsInLine(text: string): Array<{ uri: string; start: number; end: number }> {
  const out: Array<{ uri: string; start: number; end: number }> = [];
  const re = /https?:\/\/[^\s<>"'）】]+/gi;
  for (const match of text.matchAll(re)) {
    let uri = match[0];
    while (uri.length > 8 && /[.,;:!?，。、)\]）]$/.test(uri)) uri = uri.slice(0, -1);
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    const start = match.index ?? 0;
    out.push({ uri, start, end: start + uri.length });
  }
  return out;
}

export function openTerminalLink(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const opened = window.open(parsed.href, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
  return true;
}

export function terminalLinkHandler(): NonNullable<ITerminalOptions["linkHandler"]> {
  return {
    activate(event, text) {
      event.preventDefault();
      openTerminalLink(text);
    },
  };
}

export function httpLinkProvider(terminal: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const found = httpUrlsInLine(line.translateToString(true));
      if (!found.length) {
        callback(undefined);
        return;
      }
      callback(
        found.map((item) => {
          const link: ILink = {
            text: item.uri,
            range: {
              start: { x: item.start + 1, y: bufferLineNumber },
              end: { x: item.end, y: bufferLineNumber },
            },
            activate: (event) => {
              event.preventDefault();
              openTerminalLink(item.uri);
            },
          };
          return link;
        }),
      );
    },
  };
}

/**
 * xterm only listens for mouse events. Phones fire pointer/touch and never
 * produce mousedown, so TUI mouse protocol and OSC 8 links would otherwise
 * ignore a tap.
 */
export function tapAsMouse(host: HTMLElement, event: PointerEvent): void {
  const target = (host.querySelector(".xterm") as HTMLElement | null) ?? host;
  const fire = (type: string, buttons: number) => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: 0,
        buttons,
        detail: 1,
      }),
    );
  };
  fire("mousedown", 1);
  fire("mouseup", 0);
}

function bindHold(element: HTMLElement, fire: () => void, repeatable: boolean): void {
  let hold: number | null = null;
  let tick: number | null = null;
  const stop = () => {
    if (hold !== null) window.clearTimeout(hold);
    if (tick !== null) window.clearInterval(tick);
    hold = null;
    tick = null;
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    fire();
    if (!repeatable) return;
    stop();
    hold = window.setTimeout(() => {
      if (!element.isConnected) return;
      tick = window.setInterval(() => {
        // A detached button never receives pointerup; see session/keys.ts.
        if (!element.isConnected) {
          stop();
          return;
        }
        fire();
      }, REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"] as const) {
    element.addEventListener(type, stop);
  }
  element.addEventListener("click", (event) => {
    if (event.detail === 0) fire();
  });
}

function keyButton(spec: KeySpec, send: (key: string) => void): HTMLButtonElement {
  const el = paintKey(spec);
  if (spec.modifier) {
    bindModifier(el, spec.modifier);
    return el;
  }
  bindHold(el, () => {
    for (const key of withModifiers(spec.key)) send(key);
  }, spec.repeat === true);
  return el;
}

function keyRow(specs: KeySpec[], label: string, send: (key: string) => void): HTMLElement {
  const row = node("div", "keys");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  for (const spec of specs) row.append(keyButton(spec, send));
  return row;
}

export type TerminalKeyboard = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
};

/**
 * xterm's helper textarea is what pops the phone IME. Keep it inert until the
 * user asks for a keyboard; scroll, taps, and on-screen keys must not focus it.
 */
export function bindXtermKeyboard(host: HTMLElement, startOpen: boolean): TerminalKeyboard {
  let wanted = startOpen;
  let attached: HTMLTextAreaElement | null = null;

  const textarea = (): HTMLTextAreaElement | null =>
    host.querySelector("textarea.xterm-helper-textarea");

  const onFocus = (): void => {
    if (!wanted) queueMicrotask(apply);
  };

  const attach = (): HTMLTextAreaElement | null => {
    const el = textarea();
    if (el === attached) return el;
    attached?.removeEventListener("focus", onFocus);
    attached = el;
    attached?.addEventListener("focus", onFocus);
    return attached;
  };

  const apply = (): void => {
    const el = attach();
    host.classList.toggle("kb-on", wanted);
    host.classList.toggle("kb-off", !wanted);
    if (!el) return;
    el.readOnly = !wanted;
    if (wanted) {
      el.removeAttribute("inputmode");
      el.focus();
      return;
    }
    el.setAttribute("inputmode", "none");
    el.blur();
  };

  apply();
  return {
    open() {
      wanted = true;
      apply();
    },
    close() {
      wanted = false;
      apply();
    },
    toggle() {
      wanted = !wanted;
      apply();
    },
    isOpen: () => wanted,
  };
}

export function syncKeyboardButton(root: ParentNode, open: boolean): void {
  const el = root.querySelector(".full-terminal-kb") as HTMLButtonElement | null;
  if (!el) return;
  el.textContent = open ? t("ft.kbHide") : t("ft.kbType");
  el.setAttribute("aria-pressed", open ? "true" : "false");
  el.setAttribute("aria-label", open ? t("ft.kbHide") : t("ft.kbOpen"));
}

/** On-screen keys the phone keyboard cannot emit, typed into the live PTY. */
export function fullTerminalPad(
  send: (key: string) => void,
  keyboard?: { toggle: () => void; isOpen: () => boolean },
): HTMLElement {
  const pad = node("div", "full-terminal-pad");
  const paint = () => {
    pad.replaceChildren();
    if (keyboard) {
      const kb = button("", "full-terminal-kb");
      kb.type = "button";
      pad.append(kb);
      syncKeyboardButton(pad, keyboard.isOpen());
      kb.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        keyboard.toggle();
        syncKeyboardButton(pad, keyboard.isOpen());
      });
    }
    const primary = keyRow(PRIMARY_KEYS, t("keys.primary"), send);
    const more = button("", "key key-more");
    more.setAttribute("aria-label", t("keys.morePad"));
    more.setAttribute("aria-expanded", state.keysExpanded ? "true" : "false");
    more.addEventListener("click", () => {
      clearModifiers();
      state.keysExpanded = !state.keysExpanded;
      saveKeysExpanded();
      paint();
    });
    primary.append(more);
    pad.append(primary);
    if (state.keysExpanded) {
      pad.append(keyRow(SECONDARY_KEYS, t("keys.more"), send), keyRow(TERTIARY_KEYS, t("keys.mods"), send));
    }
  };
  paint();
  return pad;
}
