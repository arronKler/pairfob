import { describe, expect, test } from "bun:test";
import { changedLines, previewBars, scrolledLines, unreadLines } from "./term-unread";

const screen = (...lines: string[]): string[] => lines;

describe("unread terminal output", () => {
  test("output that scrolled the screen counts as that many lines", () => {
    const before = screen("a", "b", "c", "d");
    const after = screen("c", "d", "e", "f");
    expect(scrolledLines(before, after)).toBe(2);
    expect(unreadLines(before, after)).toBe(2);
  });

  test("an unchanged screen is not new output", () => {
    const same = screen("a", "b", "c");
    expect(unreadLines(same, same)).toBe(0);
    expect(scrolledLines(same, same)).toBe(0);
  });

  test("a TUI repainting in place reports the rows it touched, not a scroll", () => {
    const before = screen("head", "one", "two", "foot");
    const after = screen("head", "ONE", "two", "foot");
    expect(scrolledLines(before, after)).toBe(0);
    expect(changedLines(before, after)).toBe(1);
    expect(unreadLines(before, after)).toBe(1);
  });

  test("the first screen of a freshly opened pane is not counted", () => {
    expect(unreadLines([], screen("a", "b"))).toBe(0);
  });

  test("preview bars describe how full the newest rows are", () => {
    const bars = previewBars(screen("x", "----------", "--"), 2, 4);
    expect(bars.length).toBe(2);
    expect(bars[0]).toBe(1);
    expect(bars[1]).toBeLessThan(1);
  });

  test("no new lines means no preview", () => {
    expect(previewBars(screen("a", "b"), 0)).toEqual([]);
  });

  test("trailing blanks do not inflate a line's width", () => {
    const [bar] = previewBars(screen("ab       "), 1, 1);
    expect(bar).toBe(1);
  });
});
