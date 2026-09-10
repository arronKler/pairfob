import { describe, expect, test } from "bun:test";

import { FullTerminalFrameGate } from "./full-terminal-frame-gate";

describe("complete-terminal frame admission", () => {
  test("waits for a matching full frame after discarding a mismatched grid", () => {
    const gate = new FullTerminalFrameGate();

    expect(gate.preflight(1n, true)).toBe("accept");
    expect(gate.settle(1n, true, true)).toBe("render");
    expect(gate.preflight(2n, false)).toBe("accept");
    expect(gate.settle(2n, false, false)).toBe("wait");
    expect(gate.preflight(3n, false)).toBe("accept");
    expect(gate.settle(3n, false, true)).toBe("wait");
    expect(gate.preflight(5n, true)).toBe("accept");
    expect(gate.settle(5n, true, true)).toBe("render");
    expect(gate.preflight(6n, false)).toBe("accept");
    expect(gate.settle(6n, false, true)).toBe("render");
  });

  test("rejects stale frames and a forward delta gap without moving the cursor", () => {
    const gate = new FullTerminalFrameGate();

    expect(gate.settle(4n, true, true)).toBe("render");
    expect(gate.preflight(4n, false)).toBe("stale");
    expect(gate.preflight(6n, false)).toBe("gap");
    expect(gate.preflight(5n, false)).toBe("accept");
  });

  test("requires a full frame again after reset", () => {
    const gate = new FullTerminalFrameGate();
    expect(gate.settle(1n, true, true)).toBe("render");
    gate.reset();
    expect(gate.settle(1n, false, true)).toBe("wait");
  });
});
