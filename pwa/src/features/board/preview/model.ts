/**
 * Board pane preview model.
 *
 * Pure projection of a `pane.read` dump into the grid the tile paints: line
 * padding, cell geometry, the fit scale that keeps glyph aspect, and which
 * panes a pass may read at all.
 */
import { parseAnsi, type StyledLine } from "../../../lib/ansi";
import { BOARD_CELL_H, BOARD_CELL_W, type TabLayout } from "../../../lib/layout";

export const BOARD_PREVIEW_MAX_PANES = 8;
export const BOARD_PREVIEW_MIN_LINES = 8;
export const BOARD_PREVIEW_MAX_LINES = 80;
export const BOARD_PREVIEW_DEFAULT_LINES = 24;

export type Preview = { text: string; hash: string };

/** Rows to read: the daemon's viewport when it is sane, else the cell height. */
export function previewLineCount(rows?: number, cellHeight?: number): number {
  const n = rows && rows >= BOARD_PREVIEW_MIN_LINES ? rows : cellHeight;
  if (!n || !Number.isFinite(n)) return BOARD_PREVIEW_DEFAULT_LINES;
  return Math.min(BOARD_PREVIEW_MAX_LINES, Math.max(BOARD_PREVIEW_MIN_LINES, Math.round(n)));
}

/** Focused pane first, then the rest, capped so a big tab cannot fan out. */
export function boardPreviewPaneIds(layout: TabLayout | null): string[] {
  if (!layout) return [];
  const ids = layout.panes.map((pane) => pane.paneId).filter(Boolean);
  const focused = layout.focusedPaneId;
  if (focused && ids.includes(focused)) {
    return [focused, ...ids.filter((id) => id !== focused)].slice(0, BOARD_PREVIEW_MAX_PANES);
  }
  return ids.slice(0, BOARD_PREVIEW_MAX_PANES);
}

export function previewGridPx(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.max(0, Math.round(cols) * BOARD_CELL_W),
    height: Math.max(0, Math.round(rows) * BOARD_CELL_H),
  };
}

function padPreviewRows(lines: StyledLine[], rows: number): StyledLine[] {
  const n = Math.max(0, Math.round(rows));
  if (!n) return lines;
  const out = lines.slice(0, n);
  while (out.length < n) out.push({ text: "", spans: [] });
  return out;
}

export function ansiPreviewModel(
  text: string,
  cols = 0,
  rows = 0,
): { lines: StyledLine[]; width: number; height: number } {
  const parsed = parseAnsi(text);
  const live = parsed.length ? parsed : [{ text: "", spans: [] }];
  const lines = rows > 0 ? padPreviewRows(live, rows) : live;
  const grid = cols > 0 && rows > 0 ? previewGridPx(cols, rows) : { width: 0, height: 0 };
  return { lines, width: grid.width, height: grid.height };
}

/** Fit the TUI grid into the cell; keep glyph aspect (no X/Y stretch). */
export function previewFillScale(
  sw: number,
  sh: number,
  cw: number,
  ch: number,
): { x: number; y: number } {
  if (sw <= 1 || cw <= 1) return { x: 1, y: 1 };
  const byWidth = cw / sw;
  const byHeight = sh > 1 && ch > 1 ? ch / sh : byWidth;
  const scale = Math.min(byWidth, byHeight);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) return { x: 1, y: 1 };
  return { x: scale, y: scale };
}

/** Normalize a wire read; anything unexpected degrades to an empty screen. */
export function previewFromRead(read: { text?: unknown; hash?: unknown } | undefined): Preview {
  return {
    text: typeof read?.text === "string" ? read.text : "",
    hash: typeof read?.hash === "string" ? read.hash : "",
  };
}
