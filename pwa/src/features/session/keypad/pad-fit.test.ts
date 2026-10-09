import { describe, expect, test } from "bun:test";
import { DOT_NARROW_BELOW_PX, DOT_NARROW_PX, DOT_PX, KEY_MIN_PX, PAGE_COUNT_PX, fitOneRow, type RowRoom } from "./pad-fit";

/**
 * A page of one row beside the pad's chrome. The rooms below are the ones
 * Chromium measured on a phone on its side: the dock is the screen less 20px,
 * the 按键 / 命令 switch is 90px and "Keys / Commands" 132px, the page name is
 * hidden under 700px, and the row's four parts stand 8px apart.
 */
const keys = (screen: number, start: number): RowRoom =>
  ({ width: screen - 20, start, end: 0, gap: 8, keyGap: 4, items: 28, columns: 7 });
const ZH = 90;
const EN = 132;

/** The narrowest key a fit leaves, beside the dots or the count it chose. */
function keyWidth(room: RowRoom): number {
  const fit = fitOneRow(room);
  const pages = Math.ceil(room.items / fit.columns);
  const paging = fit.counted ? PAGE_COUNT_PX : pages * (room.width >= DOT_NARROW_BELOW_PX ? DOT_PX : DOT_NARROW_PX);
  const row = room.width - room.start - room.end - 3 * room.gap - paging;
  return (row - (fit.columns - 1) * room.keyGap) / fit.columns;
}

describe("how many keys a one-row page holds", () => {
  test("the whole row of seven wherever it fits at 44px", () => {
    for (const [screen, start] of [[844, ZH], [844, EN], [740, EN], [667, ZH], [667, EN], [640, ZH], [640, EN], [568, ZH]] as const) {
      expect(fitOneRow(keys(screen, start)), `${screen} ${start}`).toEqual({ columns: 7, counted: false });
      expect(keyWidth(keys(screen, start)), `${screen} ${start}`).toBeGreaterThanOrEqual(KEY_MIN_PX);
    }
  });

  test("dots are never drawn closer than a finger can aim: a row short of them counts its pages instead", () => {
    // English at 568: four dots of 24px leave the seven keys 3px short. A count
    // is narrower than the dots, so the page keeps all seven.
    expect(fitOneRow(keys(568, EN))).toEqual({ columns: 7, counted: true });
    // 480: six in Chinese, five in English, counted.
    expect(fitOneRow(keys(480, ZH))).toEqual({ columns: 6, counted: true });
    expect(fitOneRow(keys(480, EN))).toEqual({ columns: 5, counted: true });
    for (const room of [keys(568, EN), keys(480, ZH), keys(480, EN)]) {
      expect(keyWidth(room)).toBeGreaterThanOrEqual(KEY_MIN_PX);
    }
    expect(DOT_NARROW_PX).toBeGreaterThanOrEqual(24);
    expect(PAGE_COUNT_PX).toBeGreaterThanOrEqual(KEY_MIN_PX);
  });

  test("dots are kept as long as a page of that size has room for them", () => {
    // 568 in Chinese fits seven with the 24px dots: the count is a last resort.
    expect(fitOneRow(keys(568, ZH)).counted).toBeFalse();
    // And a page is not made smaller while a count would let it stay.
    expect(fitOneRow(keys(568, EN)).columns).toBe(7);
    // A single page has nothing to count.
    expect(fitOneRow({ width: 300, start: 90, end: 0, gap: 8, keyGap: 4, items: 3, columns: 7 }).counted).toBeFalse();
  });

  test("commands keep their four columns down to 480px, beside Edit", () => {
    const commands = (screen: number, start: number): RowRoom =>
      ({ width: screen - 20, start, end: 31, gap: 8, keyGap: 6, items: 14, columns: 4 });
    for (const [screen, start] of [[844, ZH], [568, EN], [480, ZH], [480, EN]] as const) {
      expect(fitOneRow(commands(screen, start)).columns, `${screen} ${start}`).toBe(4);
      expect(keyWidth(commands(screen, start)), `${screen} ${start}`).toBeGreaterThanOrEqual(KEY_MIN_PX);
    }
  });

  test("a row that has not been laid out is taken as written, and no page is ever under three keys", () => {
    expect(fitOneRow({ ...keys(844, ZH), width: 0 })).toEqual({ columns: 7, counted: false });
    expect(fitOneRow({ ...keys(300, EN) })).toEqual({ columns: 3, counted: true });
    expect(fitOneRow({ width: 200, start: 90, end: 0, gap: 8, keyGap: 6, items: 2, columns: 4 }).columns).toBe(3);
  });
});
