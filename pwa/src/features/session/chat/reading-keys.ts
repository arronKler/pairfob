import { hardwareKeyboard } from "../../../app/input-mode";
import { streamEl } from "./agent-chat-controller";

/**
 * Reading a conversation from the keyboard.
 *
 * A browser scrolls with the keyboard only what holds focus, and a conversation
 * opens with focus on the page or in its draft field: PageDown did nothing
 * until the reader had clicked the transcript once. These keys scroll it from
 * wherever in the session the keyboard is, by the distances a browser uses, so
 * the first press and the hundredth feel the same.
 */

/** One arrow press, the step browsers use for a scroller. */
const LINE_PX = 40;
/** A page keeps a strip of what was on screen, as a browser's does. */
const PAGE_SHARE = 0.875;

/** Where `event` moves a transcript at `top`, or null when it is not a reading key. */
export function readingScrollTop(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  top: number,
  viewport: number,
  content: number,
): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const page = Math.max(LINE_PX, Math.floor(viewport * PAGE_SHARE));
  const end = Math.max(0, content - viewport);
  const to = (next: number): number => Math.max(0, Math.min(end, next));
  // Space pages down and Shift+Space back up; no other reading key takes Shift.
  if (event.key === " ") return to(top + (event.shiftKey ? -page : page));
  if (event.shiftKey) return null;
  switch (event.key) {
    case "ArrowUp": return to(top - LINE_PX);
    case "ArrowDown": return to(top + LINE_PX);
    case "PageUp": return to(top - page);
    case "PageDown": return to(top + page);
    case "Home": return 0;
    case "End": return end;
    default: return null;
  }
}

function scrollStream(event: KeyboardEvent, stream: HTMLElement): boolean {
  const next = readingScrollTop(event, stream.scrollTop, stream.clientHeight, stream.scrollHeight);
  if (next === null) return false;
  event.preventDefault();
  // The stream's own scroll handler follows from here: the tail, older history.
  stream.scrollTop = next;
  return true;
}

/**
 * A reading key pressed while the session, not a field, has the keyboard.
 * Returns true when it scrolled the transcript. Focus inside the transcript is
 * left to the browser, which already scrolls it from there. Without a hardware
 * keyboard nothing runs: the phone's keys stay exactly as they were.
 */
export function readAgentStream(event: KeyboardEvent): boolean {
  if (!hardwareKeyboard() || event.isComposing) return false;
  const stream = streamEl();
  if (!stream || (event.target instanceof Node && stream.contains(event.target))) return false;
  return scrollStream(event, stream);
}

/**
 * PageUp and PageDown in the draft field page the conversation, as they page
 * the session from the guided field: opening a session puts the caret in the
 * field, and the reader should not have to leave it to look back. A draft tall
 * enough to scroll inside the field keeps both keys.
 */
export function pageAgentStreamFromField(event: KeyboardEvent, field: HTMLTextAreaElement): boolean {
  if (event.key !== "PageUp" && event.key !== "PageDown") return false;
  if (!hardwareKeyboard() || event.isComposing || event.shiftKey) return false;
  if (field.scrollHeight > field.clientHeight) return false;
  const stream = streamEl();
  return stream !== null && scrollStream(event, stream);
}
