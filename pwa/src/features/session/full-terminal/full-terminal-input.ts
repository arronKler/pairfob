import type { ILink, ILinkProvider, ITerminalOptions, Terminal } from "@xterm/xterm";

export { encodeTerminalKey } from "../keypad/terminal-keys";

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
 * produce mousedown, so TUI mouse protocol and links would otherwise ignore a
 * tap. A tap is replayed as the whole of what a mouse does to press a spot:
 *
 * - on the screen, where xterm's link layer listens; the press bubbles from
 *   there to the element around it, where the mouse protocol does. Sent to
 *   that outer element it never reached the link layer, and a tapped URL
 *   opened nothing;
 * - a move onto the spot first: xterm only knows the link under a pointer that
 *   has moved over it, and opens the link a press both began and ended on;
 * - and before that a move somewhere else, for the link layer alone: it looks
 *   under the pointer only when the cell changes, and it remembers the last
 *   cell after the pointer has left. Without it a second tap on the same spot
 *   of a URL found no link and opened nothing;
 * - and the pointer leaving afterwards, so the link does not stay underlined
 *   as hovered under a finger that is gone.
 *
 * `window.open` runs inside the tap's own event, so it counts as the reader's.
 *
 * A press that was held (`held`) is still a click for a TUI that reads the
 * mouse, but it is not how a link is opened: it goes without the moves, so the
 * link layer has nothing under it.
 */
export function tapAsMouse(
  host: HTMLElement,
  event: Pick<PointerEvent, "clientX" | "clientY" | "screenX" | "screenY">,
  held = false,
): void {
  const target = host.querySelector<HTMLElement>(".xterm-screen") ?? host.querySelector<HTMLElement>(".xterm") ?? host;
  const fire = (type: string, buttons: number, bubbles = true, at: { clientX: number; clientY: number } = event) => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles,
        cancelable: true,
        view: window,
        clientX: at.clientX,
        clientY: at.clientY,
        screenX: event.screenX + at.clientX - event.clientX,
        screenY: event.screenY + at.clientY - event.clientY,
        button: 0,
        buttons,
        detail: 1,
      }),
    );
  };
  if (!held) {
    // The corner of the screen farthest from the tap is another cell on any
    // grid larger than one. It does not bubble: a program tracking the mouse
    // is told about the tap, not about a pointer that was never there.
    const box = target.getBoundingClientRect();
    fire("mousemove", 0, false, {
      clientX: event.clientX < box.left + box.width / 2 ? box.right - 1 : box.left + 1,
      clientY: event.clientY < box.top + box.height / 2 ? box.bottom - 1 : box.top + 1,
    });
    fire("mousemove", 0);
  }
  fire("mousedown", 1);
  fire("mouseup", 0);
  fire("mouseleave", 0, false);
}

export type TerminalKeyboard = {
  /** Let xterm take keys; `focus: false` leaves the caret where the reader has it. */
  open: (focus?: boolean) => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  destroy: () => void;
};

/**
 * xterm's helper textarea is what pops the phone IME. Keep it inert until the
 * user asks for a keyboard; scroll, taps, and on-screen keys must not focus it.
 * `mayFocus` lets a terminal that starts open leave the caret where the reader
 * is typing; an explicit open, toggle or tap always takes it.
 */
export function bindXtermKeyboard(
  host: HTMLElement,
  startOpen: boolean,
  mayFocus: () => boolean = () => true,
): TerminalKeyboard {
  let wanted = startOpen;
  let attached: HTMLTextAreaElement | null = null;
  let alive = true;

  const textarea = (): HTMLTextAreaElement | null =>
    host.querySelector("textarea.xterm-helper-textarea");

  const onFocus = (): void => {
    if (!wanted) queueMicrotask(() => apply());
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

  const apply = (focus = true): void => {
    if (!alive) return;
    const el = attach();
    host.classList.toggle("kb-on", wanted);
    host.classList.toggle("kb-off", !wanted);
    if (!el) return;
    el.readOnly = !wanted;
    // Switched off it gives focus straight back (`onFocus`), so it must not be
    // somewhere Tab stops: the walk from `···` to the dock would lose a press
    // there. A press or `focus()` still reaches it, which is how it is opened.
    el.tabIndex = wanted ? 0 : -1;
    if (wanted) {
      el.removeAttribute("inputmode");
      if (focus) el.focus();
      return;
    }
    el.setAttribute("inputmode", "none");
    el.blur();
  };

  apply(mayFocus());
  return {
    open(focus = true) {
      if (!alive) return;
      wanted = true;
      apply(focus);
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
