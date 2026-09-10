import { describe, expect, test } from "bun:test";
import { BOARD_GESTURE_SLOP_PX, boardDragMode, boardScrollLines } from "./gesture.ts";

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

  test("finger-down maps onto remote scroll-up after the line threshold", () => {
    expect(BOARD_GESTURE_SLOP_PX).toBe(12);
    const first = boardScrollLines(0, 12);
    expect(first.lines).toBe(0);
    const second = boardScrollLines(first.remainder, 12);
    expect(second.direction).toBe("up");
    expect(second.lines).toBe(1);
  });
});
