import type { Terminal } from "@xterm/xterm";
import { reportsWheel, type ScrollAt } from "./full-terminal-scroll";

/** A raw attach stream's history belongs to the viewer, not the remote PTY. */
export const CLIENT_TERMINAL_HISTORY = 1000;

/**
 * Raw-stream viewers scroll their own main buffer. A TUI that requested mouse
 * input gets xterm's own encoder, which knows its current mouse protocol.
 * Never let xterm's no-scrollback fallback type arrows into a shell or editor.
 */
export function scrollClientTerminal(
  terminal: Terminal,
  host: HTMLElement,
  direction: "up" | "down",
  lines: number,
  source: "wheel" | "page_key",
  at?: ScrollAt,
): boolean {
  const delta = direction === "up" ? -1 : 1;
  const count = Math.min(160, Math.max(1, Math.round(lines)));
  if (source === "page_key") {
    const hostScroll = terminal.buffer.active.type === "normal"
      && terminal.modes.mouseTrackingMode === "none"
      // Bracketed paste keeps shell line editors local; e.g. less -X wants keys.
      && (!terminal.modes.applicationCursorKeysMode || terminal.modes.bracketedPasteMode);
    if (hostScroll) terminal.scrollLines(delta * count);
    else terminal.input(direction === "up" ? "\x1b[5~" : "\x1b[6~");
    return true;
  }
  if (reportsWheel(terminal.modes.mouseTrackingMode)) {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return false;
    const box = screen.getBoundingClientRect();
    const column = Math.min(terminal.cols - 1, Math.max(0, at?.column ?? 0));
    const row = Math.min(terminal.rows - 1, Math.max(0, at?.row ?? 0));
    for (let line = 0; line < count; line++) screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaMode: 1, deltaY: delta,
      clientX: box.left + (column + 0.5) * box.width / terminal.cols,
      clientY: box.top + (row + 0.5) * box.height / terminal.rows,
    }));
    return true;
  }
  if (terminal.buffer.active.type === "normal") {
    terminal.scrollLines(delta * count);
    return true;
  }
  return false;
}
