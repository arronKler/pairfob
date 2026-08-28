import { lineFillBackground, paintLines, spanCss, type StyledLine } from "../../lib/ansi";
import { node } from "../../lib/dom";
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } from "../../lib/protocol/terminal";
import { reportMutationError } from "../../mutations";
import { render } from "../../paint";
import { app, clampTermFont, haptic, saveTermFont, saveTermWrap, state, termLineHeightPx } from "../../state";
import { bindHostScroll, pageLineCount, scrollRail } from "../full-terminal-scroll";
import { focusCompose } from "./compose";
import { guidedScrollController } from "./guided-scroll";
import { answerPrompt, sendPage } from "./keys";
import { paneModel, type PaneModel } from "./model";

const BOTTOM_SLACK = 32;
const TAP_SLOP_PX = 8;
const HOLD_MS = 420;

export function termElement(): HTMLElement | null {
  return app.querySelector(".term");
}

export function atBottom(term: HTMLElement): boolean {
  return term.scrollHeight - term.scrollTop - term.clientHeight < BOTTOM_SLACK;
}

export function stickBottom(): void {
  const term = termElement();
  if (!term) return;
  term.scrollTop = term.scrollHeight;
  state.paneFollow = true;
  state.paneUnread = false;
  syncJump();
}

/** Show or hide the new-output affordance without repainting the buffer. */
export function syncJump(): void {
  const jump = app.querySelector(".term-jump") as HTMLElement | null;
  if (jump) jump.hidden = state.paneFollow || !state.paneUnread;
}

function sendGuidedTuiScroll(direction: "up" | "down", lines = 1, source: "wheel" | "page_key" = "wheel"): void {
  if (source === "page_key") {
    void sendPage(direction);
    return;
  }
  const session = state.live;
  const paneId = state.paneId;
  if (!session || !paneId) return;
  const term = termElement();
  const cols = Math.min(
    TERMINAL_MAX_COLS,
    Math.max(TERMINAL_MIN_COLS, Math.round((term?.clientWidth || 480) / Math.max(1, state.termFontPx * 0.6))),
  );
  const rows = Math.min(
    TERMINAL_MAX_ROWS,
    Math.max(TERMINAL_MIN_ROWS, Math.round((term?.clientHeight || 320) / Math.max(1, termLineHeightPx(state.termFontPx)))),
  );
  haptic(4);
  void guidedScrollController.scroll({ session, paneId, cols, rows }, direction, lines).catch((error) => {
    void reportMutationError(session, error);
  });
}

/** One-screen TUI snapshots cannot CSS-scroll; pan then pages the live agent. */
function guidedCapturePan(fingerDy: number): boolean {
  const term = termElement();
  if (!term) return false;
  if (term.scrollHeight - term.clientHeight <= 8) return true;
  if (fingerDy > 0 && term.scrollTop <= 1) return true;
  if (fingerDy < 0 && atBottom(term)) return true;
  return false;
}

function pageScrollLines(): number {
  const term = termElement();
  if (!term) return 1;
  const row = Math.max(1, termLineHeightPx(state.termFontPx));
  return pageLineCount(Math.max(1, Math.round(term.clientHeight / row)));
}

function lineRow(line: StyledLine): HTMLElement {
  const row = node("div", "term-line");
  const fill = lineFillBackground(line.spans);
  if (fill) row.style.backgroundColor = fill;
  if (!line.spans.length) row.append(document.createTextNode("\u00a0"));
  else {
    for (const span of line.spans) {
      const el = node("span");
      el.textContent = span.text || "\u00a0";
      Object.assign(el.style, spanCss(span.style));
      row.append(el);
    }
  }
  return row;
}

function termInner(term: HTMLElement): HTMLElement {
  const mounted = term.querySelector(".term-inner");
  if (mounted instanceof HTMLElement) return mounted;
  const inner = node("div", "term-inner");
  term.replaceChildren(inner);
  return inner;
}

export function fillTerm(term: HTMLElement, model: PaneModel): void {
  const painted = paintLines(model.lines);
  const live = painted.length ? painted : [{ text: "", spans: [] }];
  const frag = document.createDocumentFragment();
  live.forEach((line, index) => {
    const row = lineRow(line);
    row.dataset.row = String(index);
    const option = model.options.get(index);
    if (option !== undefined) {
      row.classList.add("term-option");
      row.dataset.option = String(option);
      row.setAttribute("role", "button");
      // Name it from the parsed option; the rendered row still carries box
      // gutters and column padding a screen reader would read out.
      const parsed = model.block.kind === "prompt-select" ? model.block.options[option] : undefined;
      row.setAttribute("aria-label", parsed ? `选择 ${parsed.n}. ${parsed.label}` : `选择 ${line.text.trim()}`);
    }
    frag.append(row);
  });
  termInner(term).replaceChildren(frag);
}

export function renderTerm(model: PaneModel): HTMLElement {
  const term = node("div", "term");
  term.setAttribute("role", "log");
  term.setAttribute("aria-label", "电脑上的终端画面");
  if (state.termWrap) term.classList.add("wrapped");
  if (state.termSelect) term.classList.add("selecting");
  fillTerm(term, model);
  return term;
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
 * Short tap types into the PTY. A numbered prompt row still answers.
 * Long-press opens the copy/quote bar. A drag is a pan, not a tap.
 */
function bindTap(term: HTMLElement, onRow: (index: number) => void): void {
  let startX = 0;
  let startY = 0;
  let armed = false;
  let panned = false;
  let hold: number | null = null;
  const clearHold = () => {
    if (hold === null) return;
    window.clearTimeout(hold);
    hold = null;
  };
  const cancel = () => {
    armed = false;
    clearHold();
  };
  term.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isPrimary || state.termSelect) return;
      armed = true;
      panned = false;
      startX = event.clientX;
      startY = event.clientY;
      const index = rowIndex(event.target);
      clearHold();
      hold = window.setTimeout(() => {
        hold = null;
        armed = false;
        if (panned || index < 0) return;
        haptic(8);
        onRow(index);
      }, HOLD_MS);
    },
    { passive: true },
  );
  term.addEventListener(
    "pointermove",
    (event) => {
      if (!armed) return;
      if (Math.abs(event.clientX - startX) > TAP_SLOP_PX || Math.abs(event.clientY - startY) > TAP_SLOP_PX) {
        panned = true;
        cancel();
      }
    },
    { passive: true },
  );
  term.addEventListener(
    "scroll",
    () => {
      panned = true;
      cancel();
    },
    { passive: true },
  );
  term.addEventListener(
    "pointerup",
    (event) => {
      const wasArmed = armed;
      const shortTap = hold !== null;
      const moved = panned;
      cancel();
      if (!wasArmed || !shortTap || moved || state.termSelect) return;
      if (Math.abs(event.clientX - startX) > TAP_SLOP_PX || Math.abs(event.clientY - startY) > TAP_SLOP_PX) return;
      if (!window.getSelection()?.isCollapsed) return;
      const index = rowIndex(event.target);
      const live = paneModel();
      const option = index >= 0 ? live.options.get(index) : undefined;
      if (option !== undefined && live.block.kind === "prompt-select") {
        void answerPrompt(live.block, option);
        return;
      }
      haptic(4);
      focusCompose();
    },
    { passive: true },
  );
  term.addEventListener("pointercancel", cancel);
  term.addEventListener("contextmenu", (event) => {
    if (state.termSelect) return;
    event.preventDefault();
  });
}

/**
 * The shell is a fixed-scale PWA, so browser pinch-zoom is off everywhere. Read
 * the two-finger gesture ourselves and move the terminal type scale instead.
 */
function bindPinch(term: HTMLElement): void {
  let base = 0;
  let basePx = 0;
  const spread = (touches: TouchList): number => {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  term.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) return;
      base = spread(event.touches);
      basePx = state.termFontPx;
    },
    { passive: true },
  );
  term.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 2 || base <= 0) return;
      event.preventDefault();
      const next = clampTermFont(basePx * (spread(event.touches) / base));
      if (next === state.termFontPx) return;
      state.termFontPx = next;
      app.style.setProperty("--term-fs", `${next}px`);
      app.style.setProperty("--term-lh", `${termLineHeightPx(next)}px`);
    },
    { passive: false },
  );
  const settle = () => {
    if (base <= 0) return;
    base = 0;
    saveTermFont();
    if (state.paneFollow) stickBottom();
  };
  term.addEventListener("touchend", settle);
  term.addEventListener("touchcancel", settle);
}

export function termView(model: PaneModel, onRow: (index: number) => void): HTMLElement {
  const wrap = node("div", "term-wrap");
  const term = renderTerm(model);
  term.addEventListener(
    "scroll",
    () => {
      const following = atBottom(term);
      if (following !== state.paneFollow) {
        state.paneFollow = following;
        if (following) state.paneUnread = false;
        syncJump();
      }
    },
    { passive: true },
  );
  // Prompt answers and compose focus read the live model at tap time: the pane
  // opens empty and the real buffer arrives through patchSessionScreen.
  bindTap(term, onRow);
  bindPinch(term);
  bindHostScroll(term, (direction, lines, source) => sendGuidedTuiScroll(direction, lines, source), () => undefined, {
    grabTouch: false,
    tapAsClick: false,
    capturePan: guidedCapturePan,
  });
  wrap.append(term);
  wrap.append(scrollRail((direction, lines, source) => sendGuidedTuiScroll(direction, lines, source), pageScrollLines));
  const jump = node("button", "term-jump", "↓ 新输出");
  jump.type = "button";
  jump.hidden = state.paneFollow || !state.paneUnread;
  jump.addEventListener("click", () => {
    haptic(6);
    stickBottom();
  });
  wrap.append(jump);
  return wrap;
}

export function sessionScroll(): { top: number; left: number; bottom: boolean } {
  const prev = termElement();
  return prev ? { top: prev.scrollTop, left: prev.scrollLeft, bottom: atBottom(prev) } : { top: 0, left: 0, bottom: true };
}

/** WebKit resets scrollTop in the same turn as replaceChildren. Apply twice. */
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
  state.termWrap = !state.termWrap;
  saveTermWrap();
  render();
}

export function toggleTermSelect(on = !state.termSelect): void {
  state.termSelect = on;
  if (on) state.paneRow = null;
  else window.getSelection()?.removeAllRanges();
  render();
}
