import { composeIME } from "../compose-store";
import { paneRow, setPaneRow } from "../session-store";
import { showError } from "../../../app/notices-store";
import { commitView } from "../../../app/host";
import { haptic, hasOpenDialog, KEYBOARD_ZONES } from "../../../lib/dom";
import { t } from "../../../lib/i18n";
import { rowPath, rowText } from "../../../lib/termrow";
import { insertCompose } from "./compose";
import { paneModel, type PaneModel } from "./pane-model";
import { deskPointer } from "../desk-pointer";
import { termElement, type RowPress } from "./term";

/** Air between the picked row and the bubble. */
const BUBBLE_GAP_PX = 6;
/** Air between a bubble beside the pointer and the pane's edge. */
const BUBBLE_EDGE_PX = 8;

/**
 * Where a mouse pressed the open row, in viewport pixels; null for a finger.
 * A finger gets a bar across the pane, under the thumb wherever it is. A mouse
 * is precise and far from a bar centred on a wide pane, so its actions open at
 * the pointer.
 */
let pressedAt: number | null = null;

export function rowBarContent(model: PaneModel): { index: number; text: string; path: string | null } | null {
  const index = paneRow();
  if (index === null) return null;
  const raw = model.texts[index];
  if (raw === undefined) return null;
  const text = rowText(raw);
  if (!text) return null;
  return { index, text, path: rowPath(raw) };
}

/** Drop a selected row that no longer has copyable text. Never call this from React render. */
export function discardEmptyPaneRow(model: PaneModel): boolean {
  if (paneRow() === null || rowBarContent(model)) return false;
  setPaneRow(null);
  return true;
}

export function openRow(index: number, at?: RowPress): void {
  pressedAt = at?.mouse && deskPointer() ? at.x : null;
  const model = paneModel();
  const raw = model.texts[index];
  const text = raw === undefined ? "" : rowText(raw);
  if (!text) {
    if (paneRow() !== null) {
      setPaneRow(null);
      commitView();
    }
    return;
  }
  setPaneRow(paneRow() === index ? null : index);
  haptic(6);
  commitView();
}

export function closeRow(): void {
  if (paneRow() === null) return;
  setPaneRow(null);
  commitView();
}

/**
 * Put a row's text on the clipboard. True once it is there: the bubble says so
 * on the pressed action and then closes (`SessionRowBar`). A banner above the
 * buffer would move every row down under the next press. A refusal closes the
 * bubble under its reason.
 */
export async function copyRow(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showError(t("err.copyDenied"));
    setPaneRow(null);
    commitView();
    return false;
  }
}

export function quoteRow(text: string): void {
  insertCompose(text);
  setPaneRow(null);
  commitView();
}

/**
 * Anchor the bubble above the picked row, or below it when the row is too
 * close to the top of the buffer. It floats over the terminal, so opening it
 * never moves a line; a row scrolled out of sight hides it until it returns.
 * Opened by a mouse it also stands at the pointer (`pressedAt`).
 */
export function placeRowBubble(bubble: HTMLElement, index: number): void {
  const stage = bubble.offsetParent ?? bubble.parentElement;
  const term = termElement();
  const row = term?.querySelector<HTMLElement>(`.term-line[data-row="${index}"]`);
  if (!stage || !term || !row) {
    bubble.dataset.offscreen = "";
    return;
  }
  const origin = stage.getBoundingClientRect();
  const view = term.getBoundingClientRect();
  const line = row.getBoundingClientRect();
  if (line.bottom <= view.top || line.top >= view.bottom) {
    bubble.dataset.offscreen = "";
    return;
  }
  delete bubble.dataset.offscreen;
  // Beside the pointer: centred on where the mouse pressed, kept inside the pane. Sized before it is measured.
  if (pressedAt === null) {
    delete bubble.dataset.anchor;
    bubble.style.left = "";
  } else {
    bubble.dataset.anchor = "pointer";
    const width = bubble.offsetWidth;
    const least = view.left + BUBBLE_EDGE_PX;
    const most = Math.max(least, view.right - BUBBLE_EDGE_PX - width);
    bubble.style.left = `${Math.round(Math.min(most, Math.max(least, pressedAt - width / 2)) - origin.left)}px`;
  }
  const height = bubble.offsetHeight;
  const above = line.top - BUBBLE_GAP_PX - height >= view.top;
  const top = above ? line.top - origin.top - BUBBLE_GAP_PX - height : line.bottom - origin.top + BUBBLE_GAP_PX;
  bubble.dataset.side = above ? "above" : "below";
  bubble.style.top = `${Math.round(top)}px`;
}

/**
 * Keep an open bubble on its row while output moves the buffer, and close it
 * on a tap anywhere outside the bubble and the terminal (terminal taps are the
 * row gesture's own business: another row, blank space, or the same row).
 *
 * Escape closes it too, and that press stops here: the reader is putting away
 * what they opened, not sending Esc to the agent, so neither the compose field
 * nor the page-level pane keys may see it. The next Escape is the session's
 * again. A dialog over the pane keeps its own Escape, as do the columns beside
 * the session while focus is in them; an IME keeps the one that cancels a
 * composition, and a bubble hidden with its row is not on screen to be
 * dismissed.
 */
export function bindRowBubble(bubble: HTMLElement, index: number): () => void {
  const doc = bubble.ownerDocument;
  const view = doc.defaultView ?? window;
  const term = termElement();
  const place = () => placeRowBubble(bubble, index);
  const onDown = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && (bubble.contains(target) || term?.contains(target))) return;
    closeRow();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || composeIME() || hasOpenDialog() || "offscreen" in bubble.dataset) return;
    if (event.target instanceof Element && event.target.closest(KEYBOARD_ZONES)) return;
    event.preventDefault();
    event.stopPropagation();
    closeRow();
  };
  term?.addEventListener("scroll", place, { passive: true });
  view.addEventListener("resize", place);
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  return () => {
    term?.removeEventListener("scroll", place);
    view.removeEventListener("resize", place);
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  };
}
