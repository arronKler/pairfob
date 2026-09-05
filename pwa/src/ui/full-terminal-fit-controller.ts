import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { panePtySize } from "../lib/layout";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "../lib/protocol/client";
import { state } from "../state";
import {
  clamp,
  clearScreenScale,
  cssCellOf,
  displayGrid,
  FULL_TERM_FONT_FAMILY,
  hostFitRows,
  hostInnerSize,
  integerizeDomRows,
  measureGlyphHeight,
  minimumHostHeight,
  paintedFontSize,
  panCanvas,
  pickFontSize,
  pitchLineHeight,
  probePanCanvas,
  ptyCols,
  sizePanCanvas,
  snapCellLineHeight,
  terminalGridSize,
  terminalViewportSize,
} from "./full-terminal-fit";
import { deferHostMinimumHeight } from "./full-terminal-lifecycle";

export type FullTerminalFittedSize = {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
};

export type FullTerminalFitResult = {
  size: FullTerminalFittedSize;
  remoteGrid: { cols: number; rows: number } | null;
};

/** Fit xterm to its visible pan row; sibling chrome must never count as terminal space. */
export function fitFullTerminal(args: {
  root: ParentNode;
  host: HTMLElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  lockedFont: number | null;
  remoteGrid: { cols: number; rows: number } | null;
}): FullTerminalFitResult | null {
  const { root, host, terminal, fitAddon, lockedFont } = args;
  const hostBox = hostInnerSize(host);
  const inner = terminalViewportSize(host, hostBox);
  if (inner.width < 8 || inner.height < 8) return null;
  const canvas = panCanvas(host);
  const pan = state.termFit === "pan";
  host.classList.toggle("is-pan", pan);
  probePanCanvas(canvas, inner.width);
  const measureCellWidth = (fontSize: number): number => {
    if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
    return cssCellOf(terminal)?.width || fontSize * 0.6;
  };
  let font = pickFontSize({
    hostWidth: inner.width,
    cellWidthAt: measureCellWidth,
    preferred: lockedFont ?? state.termFontPx,
    locked: lockedFont !== null || pan,
  });
  terminal.options.fontSize = font;
  try {
    fitAddon.fit();
  } catch {
    /* probe paint size */
  }
  const painted = paintedFontSize(host, font);
  if (painted > font) {
    font = painted;
    terminal.options.fontSize = font;
  }
  const dpr = window.devicePixelRatio || 1;
  const glyphHeight = measureGlyphHeight(FULL_TERM_FONT_FAMILY, font);
  const rowsGuess = clamp(
    Math.floor(inner.height / Math.max(1, font * 1.5)),
    TERMINAL_MIN_ROWS,
    TERMINAL_MAX_ROWS,
  );
  terminal.options.fontSize = font;
  terminal.options.lineHeight = pitchLineHeight(font, glyphHeight, dpr, rowsGuess);
  terminal.options.letterSpacing = 0;
  try {
    fitAddon.fit();
  } catch {
    // A hidden page can briefly report a zero-sized host. The next observer
    // callback or pageshow will fit again.
  }
  const cell = cssCellOf(terminal);
  const visibleCols = clamp(
    cell ? Math.floor(inner.width / cell.width) : terminal.cols || 80,
    TERMINAL_MIN_COLS,
    TERMINAL_MAX_COLS,
  );
  const paneSize = panePtySize(state.paneId, state.layouts, state.agents);
  const targetCols = paneSize ? clamp(paneSize.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) : state.termCols;
  const targetRows = paneSize ? clamp(paneSize.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS) : null;
  let remoteGrid = args.remoteGrid;
  if (targetRows && !remoteGrid) remoteGrid = { cols: targetCols, rows: targetRows };
  const cols = clamp(ptyCols(visibleCols, state.termFit, targetCols), TERMINAL_MIN_COLS, TERMINAL_MAX_COLS);
  // Snapshot rows can reflect the smaller PTY requested while the keypad was
  // expanded. Only the visible host determines the next request, so closing
  // the pad can grow it again; displayGrid still waits for the remote frame.
  const rows = clamp(
    cell ? hostFitRows(inner.height, cell.height) : terminal.rows || 24,
    TERMINAL_MIN_ROWS,
    TERMINAL_MAX_ROWS,
  );
  const display = displayGrid({ cols, rows }, remoteGrid);
  const pitched = pitchLineHeight(font, glyphHeight, dpr, display.rows);
  if (Math.abs(pitched - (terminal.options.lineHeight || 0)) > 0.001) terminal.options.lineHeight = pitched;
  const used = cssCellOf(terminal);
  if (used) {
    const snapped = snapCellLineHeight(terminal.options.lineHeight || pitched, used.height);
    if (Math.abs(snapped - (terminal.options.lineHeight || 0)) > 0.001) terminal.options.lineHeight = snapped;
  }
  if (terminal.cols !== display.cols || terminal.rows !== display.rows) terminal.resize(display.cols, display.rows);
  clearScreenScale(host);
  const measured = cssCellOf(terminal) || cell;
  const minimumHeight = minimumHostHeight(measured?.height || 0, TERMINAL_MIN_ROWS, host.clientHeight - hostBox.height);
  deferHostMinimumHeight(host.parentElement, minimumHeight);
  const visual = terminalGridSize(root, terminal, display.cols, display.rows);
  const size = {
    cols,
    rows,
    cellWidth: Math.max(1, Math.round(measured?.width || visual.cellWidth)),
    cellHeight: Math.max(1, Math.round(measured?.height || visual.cellHeight)),
  };
  sizePanCanvas(canvas, pan, display.cols, measured?.width || size.cellWidth, inner.width);
  integerizeDomRows(host, size.cellHeight);
  return { size, remoteGrid };
}
