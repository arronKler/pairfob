/**
 * Board tile content level.
 *
 * Geometry stays true to herdr at every zoom; what a tile draws depends on how
 * large it actually is on screen. Too small for a title: the agent mark alone.
 * Readable title but a terminal glyph under 8px: a status card with the last
 * few output lines in UI type. Glyphs at 8px or more: the live ANSI screen.
 */
import { BOARD_CELL_H } from "../../../lib/layout";

export type TileLevel = "mark" | "card" | "live";

/** On-screen tile size below which only the agent mark fits. */
export const TILE_MARK_MAX_W = 96;
export const TILE_MARK_MAX_H = 54;
/** On-screen terminal glyph size from which the live screen is readable. */
export const TILE_LIVE_GLYPH_PX = 8;
/** The board font is sized so a glyph fills 13.33 of a 16px cell (see board-preview). */
const GLYPH_PER_CELL_H = 13.333 / BOARD_CELL_H;

/** Terminal glyph height on screen at a camera scale. */
export function glyphPx(scale: number): number {
  return BOARD_CELL_H * GLYPH_PER_CELL_H * scale;
}

/** Level of one tile whose stage box is `width × height` at camera `scale`. */
export function tileLevel(width: number, height: number, scale: number): TileLevel {
  if (width * scale < TILE_MARK_MAX_W || height * scale < TILE_MARK_MAX_H) return "mark";
  return glyphPx(scale) >= TILE_LIVE_GLYPH_PX ? "live" : "card";
}
