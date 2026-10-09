import { macPlatform } from "../../app/input-mode";
import { composeEnterSends } from "../settings/preferences-store";

/**
 * Return on a phone keyboard adds a line (session page v2): soft keyboards
 * have no Shift+Enter, so the send button is the only way to send. The
 * "键盘回车直接发送" preference restores the old behaviour. A desktop or
 * external keyboard keeps Enter = send, Shift+Enter = new line.
 *
 * True when the caller must let the textarea insert the newline itself.
 */
export function returnAddsNewline(event: KeyboardEvent, phoneField: boolean): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  return phoneField && !composeEnterSends();
}

/**
 * Control chords typed in the compose field go to the program on the computer
 * (Ctrl+C, Ctrl+D, Ctrl+R…). Off macOS a few of them are also how a text field
 * is edited, and a reader with words in the field means the field: paste always,
 * and select-all, cut, undo and redo while there is a draft to act on. On macOS
 * those are Command chords, so every Control chord stays the program's.
 */
export function fieldKeepsControlChord(letter: string, hasDraft: boolean): boolean {
  if (macPlatform()) return false;
  const key = letter.toLowerCase();
  if (key === "v") return true;
  return hasDraft && (key === "a" || key === "x" || key === "z" || key === "y");
}

/** The phone field's keyboard hint follows what Return will do. */
export function phoneEnterKeyHint(): "enter" | "send" {
  return composeEnterSends() ? "send" : "enter";
}

// A leading command token such as /goal or /mcp:list; a path like /usr/bin is text.
const LEADING_SLASH = /^\s*\/[\w:.-]*(?=\s|$)[ \t]*/;

/**
 * The draft with `token` at its start, replacing a slash command already there:
 * write the goal, then tap /goal.
 */
export function withSlashCommand(draft: string, token: string): string {
  return `${token.trim()} ${draft.replace(LEADING_SLASH, "")}`;
}

/** A saved command inserted at the caret (an empty draft is simply filled). */
export function withQuickCommand(draft: string, start: number, end: number, text: string): { next: string; caret: number } {
  if (!draft) return { next: text, caret: text.length };
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  // Keep words typed on either side of the caret apart from the inserted command.
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const addition = lead + text + trail;
  return { next: before + addition + after, caret: start + lead.length + text.length };
}
