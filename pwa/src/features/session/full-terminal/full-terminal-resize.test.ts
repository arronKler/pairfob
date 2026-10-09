import { describe, expect, test } from "bun:test";
import { FullTerminalResizeGate } from "./full-terminal-resize.ts";

const size = (cols: number, rows: number, cellWidth = 8, cellHeight = 16) => ({ cols, rows, cellWidth, cellHeight });

describe("the computer's terminal is asked once per size", () => {
  test("the first request after an open carries the cell size, and its echo asks nothing", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 149, rows: 31 });
    // The bridge opened with a grid only; the cell's pixel size still has to reach the computer.
    expect(gate.admit(size(149, 31), { cols: 149, rows: 31 })).toBeTrue();
    expect(gate.admit(size(149, 31), { cols: 149, rows: 31 })).toBeFalse();
    expect(gate.admit(size(149, 31))).toBeFalse();
  });

  test("a refit before the first frame asks nothing for the grid the bridge opened with", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 60, rows: 31 });
    // A draft growing a line resizes the host and leaves the grid alone, again and again.
    expect(gate.admit(size(60, 31, 7, 21))).toBeFalse();
    expect(gate.admit(size(60, 31, 7, 21))).toBeFalse();
    // The cell size is still owed, and goes with the answer to the computer's first frame.
    expect(gate.admit(size(60, 31, 7, 21), { cols: 60, rows: 31 })).toBeTrue();
    expect(gate.admit(size(60, 31, 7, 21))).toBeFalse();
  });

  test("a refit to another grid before the first frame is asked, and carries the cell size", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 60, rows: 31 });
    expect(gate.admit(size(60, 31, 7, 21))).toBeFalse();
    expect(gate.admit(size(60, 24, 7, 21))).toBeTrue();
    // The first frame then finds nothing left to say.
    expect(gate.admit(size(60, 24, 7, 21), { cols: 60, rows: 24 })).toBeFalse();
  });

  test("a reopened bridge owes its cell size again", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 60, rows: 31 });
    expect(gate.admit(size(60, 31, 7, 21), { cols: 60, rows: 31 })).toBeTrue();
    gate.opened({ cols: 60, rows: 31 });
    expect(gate.admit(size(60, 31, 7, 21))).toBeFalse();
    expect(gate.admit(size(60, 31, 7, 21), { cols: 60, rows: 31 })).toBeTrue();
  });

  test("a window resize and the frame that answers it are one request", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 149, rows: 31 });
    gate.admit(size(149, 31));
    expect(gate.admit(size(131, 31))).toBeTrue();
    // The host observer and the answering frame both refit to the same size.
    expect(gate.admit(size(131, 31))).toBeFalse();
    expect(gate.admit(size(131, 31), { cols: 131, rows: 31 })).toBeFalse();
  });

  test("a frame that reports another grid is told the wanted size again", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 149, rows: 31 });
    gate.admit(size(149, 31));
    expect(gate.admit(size(149, 31), { cols: 100, rows: 40 })).toBeTrue();
  });

  test("a new type size is a new request even on the same grid", () => {
    const gate = new FullTerminalResizeGate();
    gate.opened({ cols: 80, rows: 24 });
    gate.admit(size(80, 24, 8, 16));
    expect(gate.admit(size(80, 24, 9, 18))).toBeTrue();
  });

  test("nothing was asked before a bridge opened", () => {
    expect(new FullTerminalResizeGate().admit(size(80, 24))).toBeTrue();
  });
});
