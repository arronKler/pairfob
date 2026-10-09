import { cssCellOf } from "./full-terminal-fit";

/**
 * The canvas while the pan row shows less of the grid than the room holds.
 *
 * The key pad a mouse calls up, and a draft past its first line, take their
 * height from that row without the computer's terminal being resized for them
 * (see `terminalRoom`), so the grid keeps rows the row has no height for. The
 * canvas stays as tall as the room, which keeps xterm fitting and drawing every
 * row, and the pan row clips what does not fit. Which end it clips follows the
 * cursor: a prompt on the first row stays where it is and the pad covers the
 * empty rows under it, while a cursor further down slides the canvas up until
 * its row clears the pad. A canvas that slid is cut on a row boundary: the pan
 * row's own edge falls wherever the heights leave it, through a row of text.
 */
type Lift = { roomHeight: number; visibleHeight: number };

/** What the last fit measured, for the frames that move the cursor before the next one. */
const lifts = new WeakMap<HTMLElement, Lift>();

/** Only the cursor's row is read, and the cell xterm measured. */
type CursorSource = { buffer: { active: { cursorY: number } } };

/**
 * Keep the canvas as tall as the room when the row shows less of it. How far it
 * slides is the cursor's to decide (`followCursor`), once the grid is settled.
 */
export function liftPanCanvas(canvas: HTMLElement | null, roomHeight: number, visibleHeight: number): void {
  if (!canvas) return;
  if (roomHeight > visibleHeight) {
    lifts.set(canvas, { roomHeight, visibleHeight });
    canvas.style.height = `${roomHeight}px`;
    return;
  }
  lifts.delete(canvas);
  canvas.style.height = "";
  canvas.style.marginTop = "";
  canvas.style.clipPath = "";
}

/**
 * How far the canvas slides up so the cursor's row, and the rows above it that
 * still fit, sit in the visible part: nothing while the row is already there,
 * and never more than what is covered.
 */
export function cursorLift(args: {
  roomHeight: number;
  visibleHeight: number;
  cellHeight: number;
  cursorRow: number;
}): number {
  const { roomHeight, visibleHeight, cellHeight } = args;
  const covered = roomHeight - visibleHeight;
  if (!(covered > 0) || !(cellHeight > 0)) return 0;
  const rowBottom = (Math.max(0, args.cursorRow) + 1) * cellHeight;
  // The room's last row takes the leftover under it along, so a grid that fills
  // the room rests exactly where it does without the pad.
  const bottom = roomHeight - rowBottom < cellHeight ? roomHeight : rowBottom;
  return Math.min(covered, Math.max(0, Math.ceil(bottom - visibleHeight)));
}

/**
 * Where a canvas that slid up by `slide` starts to show, from its own top: the
 * first row boundary at or under the pan row's edge. The part of a row left
 * above it is hidden, so the first line the reader sees is a whole one.
 */
export function liftClip(slide: number, cellHeight: number): number {
  if (!(slide > 0) || !(cellHeight > 0)) return 0;
  // A slide that is whole rows but for float error cuts nothing more.
  return Math.ceil(slide / cellHeight - 0.02) * cellHeight;
}

/** Slide a lifted canvas to where the cursor is now. A canvas the row shows whole is left alone. */
export function followCursor(canvas: HTMLElement | null, terminal: CursorSource): void {
  const lift = canvas ? lifts.get(canvas) : undefined;
  if (!canvas || !lift) return;
  const cellHeight = cssCellOf(terminal)?.height ?? 0;
  const slide = cursorLift({ ...lift, cellHeight, cursorRow: terminal.buffer.active.cursorY });
  const margin = slide > 0 ? `-${slide}px` : "";
  if (canvas.style.marginTop !== margin) canvas.style.marginTop = margin;
  const cut = liftClip(slide, cellHeight);
  const clip = cut > slide ? `inset(${cut}px 0 0 0)` : "";
  if (canvas.style.clipPath !== clip) canvas.style.clipPath = clip;
}
