import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./full-terminal-loader.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live.ts", import.meta.url)).text();
const mainSource = await Bun.file(new URL("../main.ts", import.meta.url)).text();

describe("full-terminal xterm preloader", () => {
  test("shares the dynamic import and waits for an idle pane", () => {
    expect(source).toContain('import { supportsWebgl2 } from "./full-terminal-renderer.ts"');
    expect(source).toContain("capabilitySupported ??= supportsWebgl2()");
    expect(source).toContain("return terminalWebglSupported()");
    expect(source).toContain('import("./full-terminal-xterm.ts")');
    expect(source).toContain("if (modulePromise) return modulePromise");
    expect(source).toContain("requestIdleCallback(load");
    expect(source).toContain("window.setTimeout(load, 250)");
    expect(source).toContain('document.visibilityState === "hidden"');
    expect(source).toContain("saveDataEnabled()");
    expect(source).toContain("!fullTerminalSupported()");
    expect(liveSource).toContain(
      'if (state.sessionTransport === "p2p" && previousTransport !== "p2p") preloadFullTerminalXterm()',
    );
    const openPaneStart = liveSource.indexOf("export async function openPane");
    const openPane = liveSource.slice(openPaneStart, liveSource.indexOf("function abandonOpenPane", openPaneStart));
    expect(openPane).not.toContain("preloadFullTerminalXterm()");
    expect(mainSource).toContain('if (state.sessionTransport === "p2p") preloadFullTerminalXterm()');
  });

  test("allows a failed preload to be retried by an explicit terminal open", () => {
    expect(source).toContain("modulePromise = null");
    expect(source).toContain("loadFullTerminalXterm().catch(() => undefined)");
  });
});
