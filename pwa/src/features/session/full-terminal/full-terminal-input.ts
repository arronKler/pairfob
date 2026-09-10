import type { ILink, ILinkProvider, ITerminalOptions, Terminal } from "@xterm/xterm";

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
export function tapAsMouse(
  host: HTMLElement,
  event: Pick<PointerEvent, "clientX" | "clientY" | "screenX" | "screenY">,
): void {
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

export type TerminalKeyboard = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  destroy: () => void;
};

/**
 * xterm's helper textarea is what pops the phone IME. Keep it inert until the
 * user asks for a keyboard; scroll, taps, and on-screen keys must not focus it.
 */
export function bindXtermKeyboard(host: HTMLElement, startOpen: boolean): TerminalKeyboard {
  let wanted = startOpen;
  let attached: HTMLTextAreaElement | null = null;
  let alive = true;

  const textarea = (): HTMLTextAreaElement | null =>
    host.querySelector("textarea.xterm-helper-textarea");

  const onFocus = (): void => {
    if (!wanted) queueMicrotask(apply);
  };

  const attach = (): HTMLTextAreaElement | null => {
    if (!alive) return null;
    const el = textarea();
    if (el === attached) return el;
    attached?.removeEventListener("focus", onFocus);
    attached = el;
    attached?.addEventListener("focus", onFocus);
    return attached;
  };

  const apply = (): void => {
    if (!alive) return;
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
      if (!alive) return;
      wanted = true;
      apply();
    },
    close() {
      if (!alive) return;
      wanted = false;
      apply();
    },
    toggle() {
      if (!alive) return;
      wanted = !wanted;
      apply();
    },
    isOpen: () => wanted,
    destroy() {
      if (!alive) return;
      alive = false;
      attached?.removeEventListener("focus", onFocus);
      attached = null;
    },
  };
}

const keyboardListeners = new Set<() => void>();
let keyboardOpen = false;

/** Subscribe to keyboard visibility changes from the terminal controller. */
export function subscribeFullTerminalKeyboard(onStoreChange: () => void): () => void {
  keyboardListeners.add(onStoreChange);
  return () => { keyboardListeners.delete(onStoreChange); };
}

export function fullTerminalKeyboardOpen(): boolean {
  return keyboardOpen;
}

export function notifyFullTerminalKeyboard(open: boolean): void {
  if (keyboardOpen === open) return;
  keyboardOpen = open;
  for (const listener of keyboardListeners) listener();
}
