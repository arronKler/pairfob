import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { boardLayouts } from "../../board/layout-store";
import { liveAgents } from "../../dashboard/catalog-store";
import { openPaneId } from "../session-store";
import { termCols, termFit, termFontPx } from "../../settings/preferences-store";
import { panePtySize } from "../../../lib/layout";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "../../../lib/protocol/client";
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
  type TermFitMode,
} from "./full-terminal-fit";
import { deferHostMinimumHeight } from "./full-terminal-lifecycle";
import { followCursor, liftPanCanvas } from "./full-terminal-lift";
import { syncPanBar } from "./full-terminal-pan-bar";
import { terminalRoom } from "./full-terminal-room";

export type FullTerminalFittedSize = {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
};

/**
 * The columns last asked of the computer, and what they were measured against.
 *
 * Both width modes resize the real terminal on the computer: "fit" to the room
 * the session column has, the fixed-column modes whenever that room is wider
 * than their columns. Only the window resizing may move it. The room already
 * leaves the inspector and the list's column out (see `terminalRoom`); the hold
 * makes the same window width mean the same columns and type whatever else
 * moved the host, so nothing is asked of the computer for a rounding difference.
 * A new width mode, target or type size is the reader (or the computer's own
 * layout) asking, and measures afresh.
 */
export type FullTerminalFitHold = {
  viewportWidth: number;
  /** The type size the reader asked for (settings, or a pinch) when this was measured. */
  preferredFont: number;
  mode: TermFitMode;
  targetCols: number;
  font: number;
  cols: number;
};

export type FullTerminalFitResult = {
  size: FullTerminalFittedSize;
  remoteGrid: { cols: number; rows: number } | null;
  /** What the next fit of this renderer holds on to; null while the cell could not be measured. */
  hold: FullTerminalFitHold | null;
};

/**
 * Fit xterm to its pan row; sibling chrome must never count as terminal space.
 * The grid is measured against the terminal's room and may be larger than the
 * row shows: extra columns pan sideways, and under the momentary key pad or a
 * draft of several lines the rows slide up only as far as the cursor's row
 * needs to stay in view.
 */
export function fitFullTerminal(args: {
  root: ParentNode;
  host: HTMLElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  lockedFont: number | null;
  remoteGrid: { cols: number; rows: number } | null;
  /** The previous fit's hold. Omit it to measure the columns afresh. */
  hold?: FullTerminalFitHold | null;
}): FullTerminalFitResult | null {
  const { root, host, terminal, fitAddon, lockedFont } = args;
  const hostBox = hostInnerSize(host);
  const inner = terminalViewportSize(host, hostBox);
  if (inner.width < 8 || inner.height < 8) return null;
  const drawn = cssCellOf(terminal);
  // The grid never has fewer rows than the protocol's least. A row too short
  // for them (a small phone on its side with its pad open) shows the part the
  // cursor is in, by the lift that serves a covered row, so the room is never
  // shorter than those rows are.
  const leastRows = (cell: { height: number } | null | undefined): number => Math.ceil(TERMINAL_MIN_ROWS * (cell?.height ?? 0));
  const visibleRoom = terminalRoom(host, inner);
  const room = { width: visibleRoom.width, height: Math.max(visibleRoom.height, leastRows(drawn)) };
  const canvas = panCanvas(host);
  const mode = termFit();
  const pan = mode === "pan";
  const paneSize = panePtySize(openPaneId(), boardLayouts(), liveAgents());
  const targetCols = paneSize ? clamp(paneSize.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) : termCols();
  const targetRows = paneSize ? clamp(paneSize.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS) : null;
  const preferredFont = lockedFont ?? termFontPx();
  const viewportWidth = window.innerWidth;
  const previous = args.hold;
  const held = previous && previous.viewportWidth === viewportWidth && previous.preferredFont === preferredFont
    && previous.mode === mode && previous.targetCols === targetCols ? previous : null;
  // xterm's own fit runs against the canvas and drops whatever that box cannot
  // hold. Nothing repaints it when the computer is not asked to resize, so the
  // box is never narrower than the grid already drawn, nor shorter than the room.
  probePanCanvas(canvas, Math.max(room.width, drawn ? terminal.cols * drawn.width : 0));
  liftPanCanvas(canvas, room.height, inner.height);
  const measureCellWidth = (fontSize: number): number => {
    if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
    return cssCellOf(terminal)?.width || fontSize * 0.6;
  };
  let font = held ? held.font : pickFontSize({
    hostWidth: room.width,
    cellWidthAt: measureCellWidth,
    preferred: preferredFont,
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
    Math.floor(room.height / Math.max(1, font * 1.5)),
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
  const colsIn = (width: number): number => clamp(
    cell ? Math.floor(width / cell.width) : terminal.cols || 80,
    TERMINAL_MIN_COLS,
    TERMINAL_MAX_COLS,
  );
  let remoteGrid = args.remoteGrid;
  if (targetRows && !remoteGrid) remoteGrid = { cols: targetCols, rows: targetRows };
  const cols = held ? held.cols : clamp(ptyCols(colsIn(room.width), mode, targetCols), TERMINAL_MIN_COLS, TERMINAL_MAX_COLS);
  // Columns the host cannot show right now pan sideways, whether the width mode
  // fixed them or the inspector is covering part of the column.
  const wide = pan || cols > colsIn(inner.width);
  host.classList.toggle("is-pan", wide);
  // Snapshot rows can reflect the smaller PTY requested while the keypad was
  // expanded. Only the terminal's room determines the next request, so closing
  // the pad can grow it again; displayGrid still waits for the remote frame.
  const rows = clamp(
    cell ? hostFitRows(room.height, cell.height) : terminal.rows || 24,
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
  sizePanCanvas(canvas, wide, display.cols, measured?.width || size.cellWidth, inner.width);
  // A first fit, or a larger type, learns the cell only now.
  if (leastRows(measured) > room.height) liftPanCanvas(canvas, leastRows(measured), inner.height);
  followCursor(canvas, terminal);
  syncPanBar(host);
  integerizeDomRows(host, size.cellHeight);
  // A fit that could not measure a cell guessed its columns; never hold a guess.
  const hold = cell ? { viewportWidth, preferredFont, mode, targetCols, font, cols } : null;
  return { size, remoteGrid, hold };
}
