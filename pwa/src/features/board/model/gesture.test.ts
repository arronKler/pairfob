import { describe, expect, test } from "bun:test";
import { BOARD_GESTURE_SLOP_PX, boardDragMode, boardScrollLines, boardWheelPan, boardWheelTravel } from "./gesture.ts";

describe("board drag vs pane scroll", () => {
  test("a clearly vertical drag on a pane scrolls that pane", () => {
    expect(boardDragMode(4, 24, "w1:p1")).toBe("scroll");
    expect(boardDragMode(-3, -30, "w1:p1")).toBe("scroll");
  });

  test("horizontal or empty-canvas drags pan the board", () => {
    expect(boardDragMode(24, 4, "w1:p1")).toBe("pan");
    expect(boardDragMode(0, 24, "")).toBe("pan");
    expect(boardDragMode(20, 20, "w1:p1")).toBe("scroll");
  });

  test("a mouse on a board taller than its window moves the board whichever way it drags", () => {
    expect(boardDragMode(4, 24, "w1:p1", true)).toBe("pan");
    expect(boardDragMode(0, -30, "w1:p1", true)).toBe("pan");
    expect(boardDragMode(24, 4, "w1:p1", true)).toBe("pan");
    expect(boardDragMode(0, 24, "", true)).toBe("pan");
  });

  test("finger-down maps onto remote scroll-up after the line threshold", () => {
    expect(BOARD_GESTURE_SLOP_PX).toBe(12);
    const first = boardScrollLines(0, 12);
    expect(first.lines).toBe(0);
    const second = boardScrollLines(first.remainder, 12);
    expect(second.direction).toBe("up");
    expect(second.lines).toBe(1);
  });
});

describe("board wheel pan", () => {
  const wheel = (deltaX: number, deltaY: number, extra: { shiftKey?: boolean; deltaMode?: number } = {}) =>
    boardWheelPan({ deltaX, deltaY, deltaMode: extra.deltaMode ?? 0, shiftKey: extra.shiftKey ?? false }, 800);

  test("a mostly sideways wheel pans by its sideways travel", () => {
    expect(wheel(60, 8)).toBe(60);
    expect(wheel(-40, 0)).toBe(-40);
  });

  test("a mostly vertical wheel is not a pan", () => {
    expect(wheel(0, 120)).toBe(0);
    expect(wheel(8, -60)).toBe(0);
    expect(wheel(30, 30)).toBe(0);
  });

  test("Shift turns a mouse wheel on its side, whichever axis the browser reports", () => {
    expect(wheel(0, 120, { shiftKey: true })).toBe(120);
    expect(wheel(-120, 0, { shiftKey: true })).toBe(-120);
  });

  test("a wheel that counts lines or pages pans a readable distance", () => {
    expect(wheel(3, 0, { deltaMode: 1 })).toBe(96);
    expect(wheel(-1, 0, { deltaMode: 2 })).toBe(-800);
  });

  test("a vertical wheel's travel uses the same units", () => {
    expect(boardWheelTravel({ deltaY: -120, deltaMode: 0 }, 600)).toBe(-120);
    expect(boardWheelTravel({ deltaY: 3, deltaMode: 1 }, 600)).toBe(96);
    expect(boardWheelTravel({ deltaY: -1, deltaMode: 2 }, 600)).toBe(-600);
  });
});
