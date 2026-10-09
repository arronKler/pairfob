import { COMPOSE_MIN_PX } from "./compose-store";
import { termFontPx, termLineHeightPx } from "../settings/preferences-store";
import { shortLandscape } from "./keypad/short-landscape";

/**
 * How tall a compose field may grow (session page v2).
 *
 * The field grows with its draft instead of scrolling inside a four-line box,
 * but the terminal above it must stay readable: at most 40 % of the visual
 * viewport, and never so tall that fewer than six terminal rows remain under
 * the header and the rest of the dock. Four lines stay available whenever the
 * screen has room for them without pushing the terminal under three rows.
 *
 * A phone on its side has no such room. There the field takes whole lines out
 * of what the terminal can spare (`terminalFloor`) and nothing more, so the
 * dock never grows past the screen and the compose row never scrolls out of it.
 */
export type ComposeRoom = {
  /** Visual viewport height (the keyboard already subtracted). */
  viewport: number;
  /** Session header height. */
  header: number;
  /** Everything in the dock except the field itself: keypad, tray, margins. */
  dockChrome: number;
  /** One terminal row. */
  termRow: number;
  /** One line of the field. */
  line: number;
  /** The field's vertical padding and borders. */
  frame: number;
  /**
   * Dense dock only (a short landscape screen): the height the terminal keeps
   * whatever the draft. The complete terminal's is its host's own minimum,
   * five rows and the scroll row; the guided buffer's is three rows, its
   * padding and the scroll row under it.
   */
  terminalFloor?: number;
};

export const COMPOSE_LINE_PX = 20.8;
export const COMPOSE_FRAME_PX = 22;
const TERMINAL_ROWS_KEPT = 6;
const TERMINAL_ROWS_FLOOR = 3;
const VIEWPORT_SHARE = 0.4;
const FLOOR_LINES = 4;

export function composeMaxPx(room: ComposeRoom): number {
  const free = room.viewport - room.header - room.dockChrome;
  const budget = Math.min(room.viewport * VIEWPORT_SHARE, free - TERMINAL_ROWS_KEPT * room.termRow);
  const floor = Math.min(room.frame + FLOOR_LINES * room.line, free - TERMINAL_ROWS_FLOOR * room.termRow);
  const max = Math.max(COMPOSE_MIN_PX, Math.floor(Math.max(budget, floor)));
  if (room.terminalFloor === undefined) return max;
  // Whole lines: a field cut mid-line at its cap shows half a row of the draft.
  const spare = free - room.terminalFloor;
  let lines = Math.floor((spare - room.frame) / room.line);
  while (lines > 1 && Math.ceil(room.frame + lines * room.line) > spare) lines--;
  return Math.min(max, lines > 1 ? Math.ceil(room.frame + lines * room.line) : COMPOSE_MIN_PX);
}

/** What the terminal above a dense dock keeps (see `ComposeRoom.terminalFloor`). */
function terminalFloor(dock: HTMLElement, termRow: number): number | undefined {
  const view = dock.ownerDocument.defaultView;
  if (!view || !dock.classList.contains("is-dense") || !shortLandscape(view)) return undefined;
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const host = dock.parentElement?.querySelector<HTMLElement>(":scope > .full-terminal-host");
  if (host) return px(view.getComputedStyle(host).minHeight);
  const stage = dock.closest(".pane-root")?.querySelector<HTMLElement>(".term-stage");
  const term = stage?.querySelector<HTMLElement>(".term");
  if (!stage || !term) return undefined;
  const style = view.getComputedStyle(term);
  // The scroll rail takes a row of the stage only where it lies under the buffer.
  const rail = stage.querySelector<HTMLElement>(".full-terminal-scroll");
  const railRow = rail && view.getComputedStyle(rail).position === "static" ? rail.offsetHeight : 0;
  return railRow + px(style.paddingTop) + px(style.paddingBottom) + TERMINAL_ROWS_FLOOR * termRow;
}

function viewportHeight(doc: Document): number {
  // The viewport binding publishes the keyboard-adjusted height; before it runs
  // (tests, first paint) the window is the best answer.
  const published = Number.parseFloat(doc.documentElement.style.getPropertyValue("--vv-height"));
  if (Number.isFinite(published) && published > 0) return published;
  return doc.defaultView?.visualViewport?.height || doc.defaultView?.innerHeight || 0;
}

/** Measure the field's surroundings. Read before the field's own height is reset. */
export function measureComposeRoom(field: HTMLTextAreaElement): ComposeRoom {
  const doc = field.ownerDocument;
  const root = field.closest(".pane-root") ?? doc.body;
  const header = root.querySelector<HTMLElement>("header.chrome")?.offsetHeight ?? 0;
  const dock = field.closest<HTMLElement>(".dock, .full-terminal-pad");
  const termRow = termLineHeightPx(termFontPx());
  const floor = dock ? terminalFloor(dock, termRow) : undefined;
  // A dense dock that has outgrown its ceiling scrolls: its box is then shorter
  // than what it holds, and the room is counted from what it holds.
  const dockHeight = dock && floor !== undefined
    ? Math.max(dock.offsetHeight, dock.scrollHeight + dock.offsetHeight - dock.clientHeight)
    : dock?.offsetHeight ?? 0;
  const dockChrome = dock ? Math.max(0, dockHeight - field.offsetHeight) : 0;
  const lineHeight = Number.parseFloat(doc.defaultView?.getComputedStyle(field).lineHeight ?? "");
  return {
    viewport: viewportHeight(doc),
    header,
    dockChrome,
    termRow,
    terminalFloor: floor,
    // A unitless computed value (some engines, tests) is a multiplier, not pixels.
    line: Number.isFinite(lineHeight) && lineHeight >= 8 ? lineHeight : COMPOSE_LINE_PX,
    frame: COMPOSE_FRAME_PX,
  };
}

/**
 * The height of the field's content and padding, rounded up to whole pixels.
 *
 * `scrollHeight` is a whole number and a stack of lines often is not: three
 * 20.8px lines over 20px of padding are 82.4px, reported as 82, and a box cut
 * to 82 still scrolls by the rest. The height is rebuilt from the line count
 * and rounded up; anything that is not whole lines is taken as reported.
 */
function contentHeight(field: HTMLTextAreaElement): number {
  const reported = field.scrollHeight;
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const line = Number.parseFloat(style?.lineHeight ?? "");
  const padding = Number.parseFloat(style?.paddingTop ?? "") + Number.parseFloat(style?.paddingBottom ?? "");
  if (!Number.isFinite(line) || line < 8 || !Number.isFinite(padding)) return reported;
  const lines = Math.round((reported - padding) / line) * line + padding;
  // The small allowance keeps a sum that is whole but for float error from gaining a pixel.
  return Math.abs(lines - reported) < 1 ? Math.ceil(lines - 0.01) : reported;
}

/** Where a field must scroll to for the caret's line to show with the field's own padding around it. */
export function caretScrollTop(box: {
  /** The caret line's top and bottom, measured from the top of the content (padding included). */
  caretTop: number; caretBottom: number;
  paddingTop: number; paddingBottom: number;
  scrollTop: number; clientHeight: number; scrollHeight: number;
}): number {
  const limit = Math.max(0, box.scrollHeight - box.clientHeight);
  let top = box.scrollTop;
  if (box.caretBottom + box.paddingBottom > top + box.clientHeight) top = box.caretBottom + box.paddingBottom - box.clientHeight;
  // The line's top wins where the field is too short for both.
  if (box.caretTop - box.paddingTop < top) top = box.caretTop - box.paddingTop;
  return Math.round(Math.min(Math.max(top, 0), limit));
}

/** What decides where a field's text wraps: copied to the element that stands in for it. */
const WRAPPING = ["font", "letter-spacing", "word-spacing", "white-space", "word-break", "overflow-wrap", "tab-size", "text-indent", "line-height"];

/** The caret line's top and bottom, from the top of the content (padding included), measured on a copy of the text up to the caret laid out at the field's width. */
function caretLine(field: HTMLTextAreaElement, style: CSSStyleDeclaration): { top: number; bottom: number } {
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const copy = field.ownerDocument.createElement("div");
  for (const property of WRAPPING) copy.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(copy.style, {
    position: "absolute", visibility: "hidden", left: "-9999px", top: "0", boxSizing: "content-box", padding: "0", border: "0",
    width: `${field.clientWidth - px(style.paddingLeft) - px(style.paddingRight)}px`,
  });
  copy.textContent = field.value.slice(0, field.selectionEnd ?? field.value.length);
  const caret = field.ownerDocument.createElement("span");
  caret.textContent = "\u200b";
  copy.append(caret);
  field.ownerDocument.body.append(copy);
  const top = px(style.paddingTop) + caret.offsetTop;
  const bottom = top + caret.offsetHeight;
  copy.remove();
  return { top, bottom };
}

/**
 * A field shortened under its draft scrolls inside itself and keeps showing
 * what it showed: the top of the draft, with the line being written out of
 * sight below. Bring the caret's line back.
 */
function revealCaretLine(field: HTMLTextAreaElement): void {
  const view = field.ownerDocument.defaultView;
  if (!view || field.scrollHeight <= field.clientHeight + 1) return;
  const style = view.getComputedStyle(field);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const caret = caretLine(field, style);
  field.scrollTop = caretScrollTop({
    caretTop: caret.top, caretBottom: caret.bottom, paddingTop: px(style.paddingTop), paddingBottom: px(style.paddingBottom),
    scrollTop: field.scrollTop, clientHeight: field.clientHeight, scrollHeight: field.scrollHeight,
  });
}

/**
 * Where a field that shows fewer lines than its draft stands so that the lines
 * it shows are whole ones: scrolled to a line's top (the caret's line among
 * them), with `top` and `bottom` the strips of its box, measured from inside
 * its border, that are not those lines.
 *
 * A field's padding scrolls with its text. A one-line field over a six-line
 * draft is 44px of box around a 20.8px line, and scrolled anywhere it shows
 * the line it is on and half of the one before it, in what was the padding.
 */
export function wholeLineWindow(box: {
  /** One line of the field. */
  line: number;
  /** The caret line's top, from the top of the content (padding included). */
  caretTop: number;
  paddingTop: number; paddingBottom: number;
  scrollTop: number; clientHeight: number; scrollHeight: number;
}): { scrollTop: number; top: number; bottom: number } {
  const shown = Math.max(1, Math.floor((box.clientHeight - box.paddingTop - box.paddingBottom + 0.5) / box.line));
  const caret = Math.max(0, Math.round((box.caretTop - box.paddingTop) / box.line));
  // The nearest line to where the field stands, moved only as far as the caret's line needs.
  let first = Math.max(0, Math.round(box.scrollTop / box.line));
  if (caret < first) first = caret;
  if (caret > first + shown - 1) first = caret - shown + 1;
  const limit = Math.max(0, box.scrollHeight - box.clientHeight);
  const scrollTop = Math.min(Math.round(first * box.line), limit);
  // At the end of the draft the field cannot scroll its last line up to the padding's edge: the strip grows to meet it.
  const top = box.paddingTop + first * box.line - scrollTop;
  return { scrollTop, top, bottom: Math.max(0, box.clientHeight - top - shown * box.line) };
}

/** Fields being watched for a scroll of their own, with whether their dock is the dense one. */
const cutFields = new WeakMap<HTMLTextAreaElement, { dense: boolean; timer: number }>();
/** After the last scroll event of a drag or a caret move: long enough for the next one of the same motion. */
const SCROLL_SETTLE_MS = 120;

function clearWholeLines(field: HTMLTextAreaElement): void {
  const frame = field.parentElement;
  if (!frame || !("cut" in frame.dataset)) return;
  delete frame.dataset.cut;
  for (const property of ["--compose-cut-top", "--compose-cut-bottom", "--compose-cut-bg"]) frame.style.removeProperty(property);
}

/**
 * A phone on its side gives the field one or two lines over the open pad. Shown
 * that short, a longer draft stands on whole lines: the field is scrolled to a
 * line's top and its frame covers the strips above and below them
 * (`[data-cut]`, compose.scss), where the lines before and after would show cut
 * through. Everywhere else a field is tall enough to scroll as fields do.
 */
function showWholeLines(field: HTMLTextAreaElement, dense: boolean): void {
  const view = field.ownerDocument.defaultView;
  const frame = field.parentElement;
  if (!view || !frame) return;
  const watched = cutFields.get(field);
  if (watched) watched.dense = dense;
  else if (dense) {
    const entry = { dense, timer: 0 };
    cutFields.set(field, entry);
    // The reader's own scroll (a drag in the field, an arrow key moving the caret)
    // settles on a line too, and so does a caret a press or a key left on a line out of sight.
    const settle = (): void => {
      view.clearTimeout(entry.timer);
      entry.timer = view.setTimeout(() => { if (field.isConnected) showWholeLines(field, entry.dense); }, SCROLL_SETTLE_MS);
    };
    for (const type of ["scroll", "pointerup", "keyup"]) field.addEventListener(type, settle, { passive: true });
  }
  if (!dense || frame.classList.contains("is-folded") || field.scrollHeight <= field.clientHeight + 1) {
    clearWholeLines(field);
    return;
  }
  const style = view.getComputedStyle(field);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const line = px(style.lineHeight);
  if (line < 8) return;
  const stand = wholeLineWindow({
    line, caretTop: caretLine(field, style).top, paddingTop: px(style.paddingTop), paddingBottom: px(style.paddingBottom),
    scrollTop: field.scrollTop, clientHeight: field.clientHeight, scrollHeight: field.scrollHeight,
  });
  if (Math.abs(field.scrollTop - stand.scrollTop) >= 1) field.scrollTop = stand.scrollTop;
  // Measured from where the field really stands: a scroll position is a whole number of pixels.
  const top = stand.top + (stand.scrollTop - field.scrollTop);
  frame.dataset.cut = "";
  frame.style.setProperty("--compose-cut-top", `${Math.max(0, top).toFixed(1)}px`);
  frame.style.setProperty("--compose-cut-bottom", `${Math.max(0, stand.bottom - (stand.scrollTop - field.scrollTop)).toFixed(1)}px`);
  frame.style.setProperty("--compose-cut-bg", style.backgroundColor);
}

/**
 * Size a compose textarea to its content within the room it has. Returns true
 * when the height changed, so the caller can keep its scroller pinned.
 *
 * The height being set is the border box, and the content is measured inside
 * the borders. They are added back, or the field is always two pixels short of
 * its draft and scrolls inside itself from the second line on.
 *
 * A field made shorter than it was (the pad opening over a phone on its side,
 * the keyboard rising) keeps the line with the caret in view, and in the dense
 * dock it stands on whole lines (`showWholeLines`).
 */
export function fitComposeHeight(field: HTMLTextAreaElement): boolean {
  const before = field.style.height;
  const was = field.offsetHeight;
  const room = measureComposeRoom(field);
  const max = composeMaxPx(room);
  field.style.maxHeight = `${max}px`;
  field.style.height = "auto";
  // Measured as the fitted field will be drawn, with no scrollbar taking width
  // from the text: a bar present only for the measurement wraps a line early.
  field.style.overflowY = "hidden";
  const borders = Math.max(0, field.offsetHeight - field.clientHeight);
  const content = contentHeight(field) + borders;
  field.style.overflowY = "";
  field.style.height = `${Math.min(Math.max(content, COMPOSE_MIN_PX), max)}px`;
  if (field.offsetHeight < was) revealCaretLine(field);
  showWholeLines(field, room.terminalFloor !== undefined);
  return field.style.height !== before;
}

/** Logical lines in a draft, for the "N 行" hint. */
export function draftLineCount(draft: string): number {
  return draft ? draft.split("\n").length : 0;
}
