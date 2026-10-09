import { macPlatform } from "../../../app/input-mode";

/**
 * A hardware keyboard's keys in live input, by the names the terminal encoder
 * knows (`terminal-keys`).
 *
 * In live input the keyboard is the session's: every press goes to the program
 * as a terminal would send it, from the compose field and from the page alike.
 * The keys the pad also has (a character, Enter, Esc, a plain arrow, Ctrl with a
 * letter) already do. This names the rest, so Home, Delete, F5, Shift+↑,
 * Alt+Backspace, Tab, Shift+Tab or a Backspace typed outside the field are sent
 * instead of dropped or left to move focus. Shift+Enter is a line break, as it
 * is in a draft: the line feed agent prompts read as "new line, do not send".
 * Returns null for a key that is not one of them, which the caller handles as
 * before, and for Command chords, which stay the browser's.
 */
const NAVIGATION: Readonly<Record<string, string>> = {
  Home: "home", End: "end", Insert: "insert", Delete: "delete",
};
const WITH_MODIFIERS: Readonly<Record<string, string>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "enter", Escape: "esc", Backspace: "backspace", PageUp: "pageup", PageDown: "pagedown",
};
/** Ctrl with one of these is a control byte of its own (Ctrl+[ is Esc, Ctrl+Space is NUL). */
const CONTROL_PUNCTUATION = /^[ @[\\\]^_?3-8]$/;

export function hardwareLiveKey(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;
  const chord = `${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift+" : ""}`;
  const functionKey = /^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : undefined;
  // Shift or Ctrl with Insert is the browser's paste and copy, as in a terminal.
  if (event.key === "Insert" && (event.shiftKey || event.ctrlKey)) return null;
  // On a Mac, Option with a function key composes nothing and xterm sends nothing for it.
  if (functionKey && event.altKey && !event.ctrlKey && macPlatform()) return null;
  const always = NAVIGATION[event.key] ?? functionKey;
  if (always) return chord + always;
  // A terminal has one Tab and one back-tab, whatever else is held.
  if (event.key === "Tab") return event.shiftKey ? "shift+tab" : "tab";
  if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey) return "ctrl+j";
  if (event.key === "Backspace" && !event.ctrlKey && !event.altKey) return "backspace";
  const modified = WITH_MODIFIERS[event.key];
  if (modified) {
    // Shift with a page key is not a key for the program.
    if (!event.ctrlKey && !event.altKey) return event.shiftKey && event.key.startsWith("Arrow") ? chord + modified : null;
    return chord + modified;
  }
  if (event.key.length !== 1) return null;
  if (event.ctrlKey && !event.altKey) {
    return CONTROL_PUNCTUATION.test(event.key) ? `ctrl+${event.key === " " ? "space" : event.key}` : null;
  }
  // Option on a Mac composes a character, which is typed; elsewhere Alt is Meta, sent as Esc and the key.
  if (event.altKey && !event.ctrlKey && !macPlatform()) return `alt+${event.key === " " ? "space" : event.key}`;
  return null;
}
