import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./full-terminal-loader.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live.ts", import.meta.url)).text();

describe("full-terminal xterm preloader", () => {
  test("shares the dynamic import and waits for an idle pane", () => {
    expect(source).toContain('import("./full-terminal-xterm.ts")');
    expect(source).toContain("if (modulePromise) return modulePromise");
    expect(source).toContain("requestIdleCallback(load");
    expect(source).toContain("window.setTimeout(load, 250)");
    expect(source).toContain('document.visibilityState === "hidden"');
    expect(source).toContain("saveDataEnabled()");
    expect(liveSource).toContain("preloadFullTerminalXterm()");
  });

  test("allows a failed preload to be retried by an explicit terminal open", () => {
    expect(source).toContain("modulePromise = null");
    expect(source).toContain("loadFullTerminalXterm().catch(() => undefined)");
  });
});
