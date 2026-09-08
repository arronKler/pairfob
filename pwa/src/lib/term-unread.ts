/**
 * How much new output arrived while the reader was looking somewhere else.
 *
 * A pane read is a rendered viewport, not an append-only log, so "new lines"
 * has to be recovered by finding how far the old screen moved up. A shell that
 * printed three lines shifts by three; a TUI that repainted in place shifts by
 * nothing and is reported as a redraw instead of a false line count.
 */

/**
 * The upward shift between two snapshots of the same viewport, or 0 when the
 * screen was repainted rather than scrolled.
 */
export function scrolledLines(previous: string[], next: string[]): number {
  if (!previous.length || !next.length) return 0;
  const rows = Math.min(previous.length, next.length);
  // A shift larger than the viewport is indistinguishable from a fresh screen.
  for (let shift = 1; shift < rows; shift++) {
    let same = true;
    for (let row = 0; row + shift < rows; row++) {
      if (previous[row + shift] !== next[row]) {
        same = false;
        break;
      }
    }
    if (same) return shift;
  }
  return 0;
}

/** Rows that differ at the same position: what a redraw looks like. */
export function changedLines(previous: string[], next: string[]): number {
  const rows = Math.max(previous.length, next.length);
  let changed = 0;
  for (let row = 0; row < rows; row++) {
    if ((previous[row] ?? "") !== (next[row] ?? "")) changed++;
  }
  return changed;
}

/**
 * New output since the last snapshot the reader saw. Scrolled output is counted
 * in lines; an in-place redraw reports the rows it touched, which is the honest
 * answer to "how much changed" even though nothing scrolled.
 */
export function unreadLines(previous: string[], next: string[]): number {
  // The first screen of a pane is what the reader opened, not news.
  if (!previous.length) return 0;
  const shift = scrolledLines(previous, next);
  return shift > 0 ? shift : changedLines(previous, next);
}

/**
 * A few bars showing how full the newest rows are, so a wall of output looks
 * different from a one-line prompt before anyone jumps to it.
 */
export function previewBars(next: string[], count: number, bars = 4): number[] {
  if (count <= 0 || !next.length) return [];
  const tail = next.slice(Math.max(0, next.length - count));
  const width = Math.max(1, ...tail.map((line) => line.trimEnd().length));
  const step = Math.max(1, Math.ceil(tail.length / bars));
  const out: number[] = [];
  for (let at = 0; at < tail.length && out.length < bars; at += step) {
    const group = tail.slice(at, at + step);
    const widest = Math.max(...group.map((line) => line.trimEnd().length));
    out.push(Math.min(1, widest / width));
  }
  return out;
}
