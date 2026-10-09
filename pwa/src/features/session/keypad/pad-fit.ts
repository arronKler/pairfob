/**
 * How many keys a page of one row holds.
 *
 * A row shares its width with the pad's chrome (the 按键 / 命令 switch, the
 * dots, a page name or Edit), and a key is never narrower than a finger needs.
 * Where the full row does not fit (an English switch on a 568px screen, any
 * language at 480px) the page takes fewer keys and the rest go to the pages
 * after it; the keys are not shrunk. More pages mean more dots, which is why
 * the count is found by trying: the widest page whose keys and dots both fit.
 *
 * A dot is something a finger aims at, so it is never drawn closer than 24px
 * to the next. A row with no room for that many dots shows the page as a count
 * ("2 / 5") instead: one target as wide as a key's minimum, which steps to the
 * next page when pressed. It is narrower than a row of dots, so it can also
 * let a page keep a key the dots would have cost it.
 */
export const KEY_MIN_PX = 44;
/** A dot's width as the style sheet draws it: roomy from 600px of row, closer under it (dock-dense.scss). */
export const DOT_PX = 32;
export const DOT_NARROW_PX = 24;
export const DOT_NARROW_BELOW_PX = 600;
/** The page count that stands in for dots: its box, a finger wide (dock-dense.scss). */
export const PAGE_COUNT_PX = 44;
/** Never fewer: a page of two keys is not a pad. */
const LEAST_COLUMNS = 3;

export type RowRoom = {
  /** The row's whole width. */
  width: number;
  /** What stands before and after the keys and dots, as drawn. */
  start: number;
  end: number;
  /** Between the row's four parts, and between two keys. */
  gap: number;
  keyGap: number;
  /** Keys in the pad, and the most a page holds. */
  items: number;
  columns: number;
};

export type RowFit = {
  columns: number;
  /** The pages are shown as a count: there is no room for dots a finger can tell apart. */
  counted: boolean;
};

export function fitOneRow(room: RowRoom): RowFit {
  const full = { columns: room.columns, counted: false };
  // A row that cannot be measured (not laid out yet) is taken as it is written.
  if (!(room.width > 0)) return full;
  const dot = room.width >= DOT_NARROW_BELOW_PX ? DOT_PX : DOT_NARROW_PX;
  const fits = (columns: number, counted: boolean): boolean => {
    const pages = Math.max(1, Math.ceil(room.items / columns));
    const paging = counted ? PAGE_COUNT_PX : pages * dot;
    const keys = room.width - room.start - room.end - 3 * room.gap - paging;
    return keys >= columns * KEY_MIN_PX + (columns - 1) * room.keyGap;
  };
  for (let columns = room.columns; columns >= LEAST_COLUMNS; columns--) {
    if (fits(columns, false)) return { columns, counted: false };
    // One page needs no count; two dots are never wider than it.
    if (Math.ceil(room.items / columns) > 1 && fits(columns, true)) return { columns, counted: true };
  }
  return { columns: Math.min(room.columns, LEAST_COLUMNS), counted: room.items > LEAST_COLUMNS };
}
