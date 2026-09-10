import { liveSession } from "../../computers/catalog-store";
import { openPaneId, paneFollow, setPaneFollow, setPaneRow, setTermSelect, termSelect } from "../session-store";
import { prefersReducedMotion } from "../../../lib/dom";
import { isPageZoomed } from "../../../lib/gesture-boundary";
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } from "../../../lib/protocol/terminal";
import { reportMutationError } from "../../connection/mutations";
import { commitView } from "../../../app/host";
import { clampTermFont, saveTermFont, setTermFontPx, setTermWrap, termFontPx, termLineHeightPx, termWrap } from "../../settings/preferences-store";
import { appRoot } from "../../../app/dom-root";
import { haptic } from "../../../lib/dom";
import { focusCompose } from "./compose";

import { guidedScrollController } from "./guided-scroll";
import { pageLineCount } from "../full-terminal/full-terminal-scroll";
import { sendPage } from "./keys";
import { paneModel, type PaneModel } from "./pane-model";
import { markCaughtUp } from "./unread";

const BOTTOM_SLACK = 32;
const TAP_SLOP_PX = 8;
const HOLD_MS = 420;
/** Long enough for the chip to leave, short enough not to outlast the scroll. */
const JUMP_OUT_MS = 220;

let jumpTimer = 0;
let jumpLeaving = false;
let frozenDisplay: { session: ReturnType<typeof liveSession>; paneId: string; model: PaneModel } | null = null;
let termDisplayRevision = 0;
const termDisplayListeners = new Set<() => void>();

export function termDisplayStoreRevision(): number {
  return termDisplayRevision;
}

export function subscribeTermDisplay(listener: () => void): () => void {
  termDisplayListeners.add(listener);
  return () => {
    termDisplayListeners.delete(listener);
  };
}

function notifyTermDisplay(): void {
  termDisplayRevision += 1;
  for (const listener of termDisplayListeners) listener();
}

export function termJumpLeaving(): boolean {
  return jumpLeaving;
}

export function cancelTermJump(): void {
  window.clearTimeout(jumpTimer);
  jumpTimer = 0;
  jumpLeaving = false;
}

/**
 * Rows shown in the terminal. While term selection is on, this is the model
 * captured when selection started so a React root repaint cannot replace row
 * nodes under an in-progress DOM Range.
 */
export function displayedTermModel(live: PaneModel): PaneModel {
  const paneId = openPaneId();
  if (!termSelect()) {
    frozenDisplay = null;
    return live;
  }
  if (frozenDisplay && frozenDisplay.session === liveSession() && frozenDisplay.paneId === paneId) return frozenDisplay.model;
  frozenDisplay = { session: liveSession(), paneId, model: live };
  return live;
}

export function termElement(): HTMLElement | null {
  // Resolved at call time: importing this controller must not require #app.
  return appRoot().querySelector(".term");
}

export function atBottom(term: HTMLElement): boolean {
  return term.scrollHeight - term.scrollTop - term.clientHeight < BOTTOM_SLACK;
}

export function stickBottom(): void {
  const term = termElement();
  if (!term) return;
  term.scrollTop = term.scrollHeight;
  setPaneFollow(true);
  markCaughtUp(openPaneId(), paneModel().texts);
  syncJump();
}

/** Show or hide the new-output affordance without repainting the buffer. */
export function syncJump(): void {
  notifyTermDisplay();
}

/**
 * Keep the row being typed into visible when the keyboard takes the bottom half
 * of the screen. Only on the way in: once the keys are up the reader owns the
 * scroll position again, so closing them must not yank the view back.
 */
export function revealCaretRow(): void {
  const term = termElement();
  if (!term) return;
  if (paneFollow()) {
    stickBottom();
    return;
  }
  const rows = [...term.querySelectorAll<HTMLElement>(".term-line")];
  const caret = [...rows].reverse().find((row) => row.textContent?.trim());
  if (!caret) return;
  const row = Math.max(1, termLineHeightPx(termFontPx()));
  // Two rows of air below the caret, so the next line of output is visible too.
  const wanted = caret.offsetTop + caret.offsetHeight + row * 2 - term.clientHeight;
  if (wanted <= term.scrollTop) return;
  term.scrollTo({ top: Math.min(wanted, term.scrollHeight), behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/**
 * Travel to the newest output instead of teleporting: seeing the lines go by is
 * what tells the reader they are now at the bottom of the same buffer.
 */
export function jumpToBottom(jump: HTMLElement): void {
  const term = termElement();
  if (!term) return;
  if (prefersReducedMotion()) {
    stickBottom();
    return;
  }
  setPaneFollow(true);
  markCaughtUp(openPaneId(), paneModel().texts);
  jumpLeaving = true;
  notifyTermDisplay();
  term.scrollTo({ top: term.scrollHeight, behavior: "smooth" });
  window.clearTimeout(jumpTimer);
  jumpTimer = window.setTimeout(() => {
    jumpTimer = 0;
    jumpLeaving = false;
    syncJump();
  }, JUMP_OUT_MS);
}

export function sendGuidedTuiScroll(direction: "up" | "down", lines = 1, source: "wheel" | "page_key" = "wheel"): void {
  if (source === "page_key") {
    void sendPage(direction);
    return;
  }
  const session = liveSession();
  const paneId = openPaneId();
  if (!session || !paneId) return;
  const term = termElement();
  const cols = Math.min(
    TERMINAL_MAX_COLS,
    Math.max(TERMINAL_MIN_COLS, Math.round((term?.clientWidth || 480) / Math.max(1, termFontPx() * 0.6))),
  );
  const rows = Math.min(
    TERMINAL_MAX_ROWS,
    Math.max(TERMINAL_MIN_ROWS, Math.round((term?.clientHeight || 320) / Math.max(1, termLineHeightPx(termFontPx())))),
  );
  haptic(4);
  void guidedScrollController.scroll({ session, paneId, cols, rows }, direction, lines).catch((error) => {
    void reportMutationError(session, error);
  });
}

/** One-screen TUI snapshots cannot CSS-scroll; pan then pages the live agent. */
export function guidedCapturePan(fingerDy: number): boolean {
  const term = termElement();
  if (!term) return false;
  if (term.scrollHeight - term.clientHeight <= 8) return true;
  if (fingerDy > 0 && term.scrollTop <= 1) return true;
  if (fingerDy < 0 && atBottom(term)) return true;
  return false;
}

export function pageScrollLines(): number {
  const term = termElement();
  if (!term) return 1;
  const row = Math.max(1, termLineHeightPx(termFontPx()));
  const viewportRows = Math.max(1, Math.round(term.clientHeight / row));
  return pageLineCount(viewportRows);
}

/** Refresh the displayed model without replacing React-owned terminal rows. */
export function fillTerm(_term: HTMLElement, model: PaneModel): void {
  displayedTermModel(model);
  notifyTermDisplay();
}

function rowAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(".term-line") : null;
}

function rowIndex(target: EventTarget | null): number {
  const row = rowAt(target);
  if (!row?.dataset.row) return -1;
  const index = Number(row.dataset.row);
  return Number.isFinite(index) ? index : -1;
}

/**
 * Short tap focuses terminal input. Long-press opens the copy/quote bar. A
 * drag is a pan, not a tap. Terminal rows never invent controls from text.
 */
export function bindTap(term: HTMLElement, onRow: (index: number) => void): () => void {
  let startX = 0;
  let startY = 0;
  let armed = false;
  let panned = false;
  let hold: number | null = null;
  let retired = false;
  const clearHold = () => {
    if (hold === null) return;
    window.clearTimeout(hold);
    hold = null;
  };
  const cancel = () => {
    armed = false;
    clearHold();
  };
  const onDown = (event: PointerEvent) => {
    if (retired || !event.isPrimary || termSelect() || isPageZoomed(term.ownerDocument)) return;
    armed = true;
    panned = false;
    startX = event.clientX;
    startY = event.clientY;
    const index = rowIndex(event.target);
    clearHold();
    hold = window.setTimeout(() => {
      hold = null;
      armed = false;
      if (retired || panned || index < 0) return;
      haptic(8);
      onRow(index);
    }, HOLD_MS);
  };
  const onMove = (event: PointerEvent) => {
    if (retired || !armed) return;
    if (Math.abs(event.clientX - startX) > TAP_SLOP_PX || Math.abs(event.clientY - startY) > TAP_SLOP_PX) {
      panned = true;
      cancel();
    }
  };
  const onScroll = () => {
    panned = true;
    cancel();
  };
  const onUp = (event: PointerEvent) => {
    const wasArmed = armed;
    const shortTap = hold !== null;
    const moved = panned;
    cancel();
    if (retired || !wasArmed || !shortTap || moved || termSelect()) return;
    if (Math.abs(event.clientX - startX) > TAP_SLOP_PX || Math.abs(event.clientY - startY) > TAP_SLOP_PX) return;
    if (!window.getSelection()?.isCollapsed) return;
    haptic(4);
    focusCompose();
  };
  const onContextMenu = (event: Event) => {
    if (termSelect()) return;
    event.preventDefault();
  };
  term.addEventListener("pointerdown", onDown, { passive: true });
  term.addEventListener("pointermove", onMove, { passive: true });
  term.addEventListener("scroll", onScroll, { passive: true });
  term.addEventListener("pointerup", onUp, { passive: true });
  term.addEventListener("pointercancel", cancel);
  term.addEventListener("contextmenu", onContextMenu);
  return () => {
    retired = true;
    cancel();
    term.removeEventListener("pointerdown", onDown);
    term.removeEventListener("pointermove", onMove);
    term.removeEventListener("scroll", onScroll);
    term.removeEventListener("pointerup", onUp);
    term.removeEventListener("pointercancel", cancel);
    term.removeEventListener("contextmenu", onContextMenu);
  };
}

/**
 * Adjust terminal type only at page scale=1; a zoomed page must remain free to
 * shrink back even when the next gesture starts on a terminal row.
 */
export function bindPinch(term: HTMLElement): () => void {
  // The root is owned by this gesture's binding lifetime; resolve it lazily so
  // importing the controller needs no document.
  const root = appRoot();
  let base = 0;
  let basePx = 0;
  let retired = false;
  const spread = (touches: TouchList): number => {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const onStart = (event: TouchEvent) => {
    if (retired) return;
    if (isPageZoomed(term.ownerDocument)) {
      base = 0;
      return;
    }
    if (event.touches.length !== 2) return;
    base = spread(event.touches);
    basePx = termFontPx();
  };
  const onMove = (event: TouchEvent) => {
    if (retired) return;
    if (isPageZoomed(term.ownerDocument)) {
      base = 0;
      return;
    }
    if (event.touches.length !== 2 || base <= 0) return;
    event.preventDefault();
    const next = clampTermFont(basePx * (spread(event.touches) / base));
    if (next === termFontPx()) return;
    setTermFontPx(next);
    root.style.setProperty("--term-fs", `${next}px`);
    root.style.setProperty("--term-lh", `${termLineHeightPx(next)}px`);
  };
  const settle = () => {
    if (retired || base <= 0) return;
    base = 0;
    saveTermFont();
    if (paneFollow()) stickBottom();
  };
  term.addEventListener("touchstart", onStart, { passive: true });
  term.addEventListener("touchmove", onMove, { passive: false });
  term.addEventListener("touchend", settle);
  term.addEventListener("touchcancel", settle);
  return () => {
    retired = true;
    base = 0;
    term.removeEventListener("touchstart", onStart);
    term.removeEventListener("touchmove", onMove);
    term.removeEventListener("touchend", settle);
    term.removeEventListener("touchcancel", settle);
  };
}

export function sessionScroll(): { top: number; left: number; bottom: boolean } {
  const prev = termElement();
  return prev ? { top: prev.scrollTop, left: prev.scrollLeft, bottom: atBottom(prev) } : { top: 0, left: 0, bottom: true };
}

/** Restore scroll after the DOM update and again on the next animation frame. */
export function restoreTermScroll(term: HTMLElement, scroll: { top: number; left: number; bottom: boolean }): void {
  const apply = () => {
    if (termElement() !== term) return;
    term.scrollLeft = scroll.left;
    term.scrollTop = scroll.bottom ? term.scrollHeight : scroll.top;
  };
  apply();
  requestAnimationFrame(apply);
}

export function toggleTermWrap(): void {
  setTermWrap(!termWrap());
  commitView();
}

export function toggleTermSelect(on = !termSelect()): void {
  setTermSelect(on);
  if (on) setPaneRow(null);
  else {
    frozenDisplay = null;
    window.getSelection()?.removeAllRanges();
  }
  commitView();
}
