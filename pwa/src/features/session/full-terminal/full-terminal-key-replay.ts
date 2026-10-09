/**
 * Give xterm a key that was pressed while it did not have the keyboard.
 *
 * In live input the keyboard is the terminal's, but focus can rest on the page
 * (after a click on something that cannot hold it). The key pressed there has
 * to reach the program as if xterm had been focused, and only xterm knows how
 * to spell most keys: Home is `ESC [ H` or `ESC O H` by the cursor-key mode the
 * program set, a modified arrow carries its modifiers, F5 is `ESC [ 15 ~`. So
 * the press is replayed on xterm's own field and xterm encodes and sends it,
 * exactly as it does the next one.
 *
 * xterm reads the legacy `keyCode`, which a constructed event carries only
 * when it is given one. Returns true when xterm took the key (it cancels the
 * keys it sends); a key it leaves alone, a dead key starting an accent or a
 * character the platform composes with Option, is still the caller's.
 */
export function replayKeyOnTerminal(host: Element | null | undefined, event: KeyboardEvent): boolean {
  const field = host?.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
  if (!field) return false;
  const view = field.ownerDocument.defaultView ?? window;
  const replayed = new view.KeyboardEvent("keydown", {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    keyCode: event.keyCode,
    which: event.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  return !field.dispatchEvent(replayed);
}
