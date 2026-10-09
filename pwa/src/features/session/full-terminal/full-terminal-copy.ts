import type { Terminal } from "@xterm/xterm";
import { macPlatform } from "../../../app/input-mode";

type SelectionTerminal = Pick<Terminal, "hasSelection" | "getSelection" | "clearSelection">;

/**
 * Copying out of the complete terminal with the keyboard.
 *
 * On macOS Command+C is the browser's copy and xterm answers it with its
 * selection; Control+C is always the program's. Everywhere else one chord is
 * both, as in every terminal on those systems: Ctrl+C copies what is selected,
 * and with nothing selected it is the interrupt. The copy drops the selection,
 * so the next Ctrl+C interrupts and a selection made earlier and forgotten
 * never stands between the reader and a runaway program.
 */
export function isControlCopy(event: KeyboardEvent): boolean {
  return !macPlatform() && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
    && event.key.toLowerCase() === "c";
}

/** Put the terminal's selection on the clipboard and drop it. False when nothing is selected. */
export function copyTerminalSelection(terminal: SelectionTerminal | null): boolean {
  if (!terminal?.hasSelection() || !navigator.clipboard) return false;
  // A clipboard the browser withholds leaves the selection for a second try by hand.
  void navigator.clipboard.writeText(terminal.getSelection()).then(() => terminal.clearSelection(), () => undefined);
  return true;
}

/**
 * Ctrl+C typed into xterm itself (live input). Capture on the host, ahead of
 * xterm's own listener on its field, so a copy never also reaches the program.
 * A key pressed on the page and replayed here (full-terminal-key-replay) meets
 * the same rule.
 */
export function bindTerminalCopyKey(host: HTMLElement, terminal: () => SelectionTerminal | null): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isControlCopy(event) || !copyTerminalSelection(terminal())) return;
    event.preventDefault();
    event.stopPropagation();
  };
  host.addEventListener("keydown", onKeyDown, true);
  return () => host.removeEventListener("keydown", onKeyDown, true);
}
