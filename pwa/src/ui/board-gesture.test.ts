import { describe, expect, test } from "bun:test";
import {
  BOARD_DOUBLE_TAP_MS,
  BOARD_GESTURE_SLOP_PX,
  boardDoubleTap,
  boardDragMode,
  boardScrollLines,
} from "./board-gesture.ts";

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

  test("two taps on the same pane inside the window are a double-tap", () => {
    expect(BOARD_DOUBLE_TAP_MS).toBe(280);
    expect(boardDoubleTap("w1:p1", 1000, "w1:p1", 1200)).toBe(true);
    expect(boardDoubleTap("w1:p1", 1000, "w1:p1", 1400)).toBe(false);
    expect(boardDoubleTap("w1:p1", 1000, "w1:p2", 1100)).toBe(false);
    expect(boardDoubleTap("", 1000, "w1:p1", 1100)).toBe(false);
  });
});
