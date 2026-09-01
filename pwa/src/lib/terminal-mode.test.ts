import { describe, expect, test } from "bun:test";

import { parseTermMode, resolveTermMode } from "./terminal-mode.ts";

describe("terminal mode policy", () => {
  test("defaults invalid or missing preferences to auto", () => {
    expect(parseTermMode("auto")).toBe("auto");
    expect(parseTermMode("guided")).toBe("guided");
    expect(parseTermMode("full")).toBe("full");
    expect(parseTermMode("agent")).toBe("agent");
    expect(parseTermMode("nope")).toBe("auto");
    expect(parseTermMode(null, "full")).toBe("full");
  });

  test("auto selects terminal only for P2P with full-terminal support", () => {
    expect(resolveTermMode("auto", { p2p: true, fullTerminalAvailable: true })).toBe("full");
    expect(resolveTermMode("auto", { p2p: false, fullTerminalAvailable: true })).toBe("guided");
    expect(resolveTermMode("auto", { p2p: true, fullTerminalAvailable: false })).toBe("guided");
  });

  test("explicit modes override the automatic context", () => {
    const unavailable = { p2p: false, fullTerminalAvailable: false };
    expect(resolveTermMode("full", unavailable)).toBe("full");
    expect(resolveTermMode("guided", unavailable)).toBe("guided");
    expect(resolveTermMode("agent", unavailable)).toBe("agent");
  });
});
