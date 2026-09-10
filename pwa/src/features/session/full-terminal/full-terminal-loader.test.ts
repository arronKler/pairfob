import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./full-terminal-loader.ts", import.meta.url)).text();
const bootSource = await Bun.file(new URL("../../../app/bootstrap.ts", import.meta.url)).text();
// The p2p transport-change preload moved with the Live colocation into the
// connection controllers, behind the typed preloadFullTerminal port. The port is
// bound to preloadFullTerminalXterm in the Live lifecycle wiring that now lives
// in features/connection/controller.ts; session-events.ts invokes it on the p2p
// transport transition; the extracted open-pane.ts never warms the terminal.
const controllerSource = await Bun.file(new URL("../../../features/connection/controller.ts", import.meta.url)).text();
const sessionEventsSource = await Bun.file(new URL("../../../features/connection/session-events.ts", import.meta.url)).text();
const openPaneSource = await Bun.file(new URL("../../../features/connection/open-pane.ts", import.meta.url)).text();

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
    // The Live lifecycle wiring binds the session-events preload port to the
    // xterm preloader in features/connection/controller.ts.
    expect(controllerSource).toContain("preloadFullTerminal: preloadFullTerminalXterm");
    expect(sessionEventsSource).toContain(
      'if (next === "p2p" && previousTransport !== "p2p") ports.preloadFullTerminal();',
    );
    // The actual open-pane implementation must not warm the terminal itself; p2p
    // warm-up belongs to the session-events transport observer above. Assert
    // against the extracted implementation body, not a stale host slice.
    expect(openPaneSource).toContain("export async function openPaneWithOwner");
    expect(openPaneSource).not.toContain("preloadFullTerminal");
    expect(bootSource).toContain('if (currentSessionTransport() === "p2p") preloadFullTerminalXterm()');
  });

  test("allows a failed preload to be retried by an explicit terminal open", () => {
    expect(source).toContain("modulePromise = null");
    expect(source).toContain("loadFullTerminalXterm().catch(() => undefined)");
  });
});
