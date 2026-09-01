import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { ITerminalAddon } from "@xterm/xterm";
import type { RendererTerminal } from "./full-terminal-renderer.ts";

const happy = new Window({ url: "https://pairfob.com/pair" });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
const originalGetContext = happy.HTMLCanvasElement.prototype.getContext;

const { WEBGL_UNAVAILABLE, fullTerminalOptions, openWebglTerminal, supportsWebgl2 } =
  await import("./full-terminal-renderer.ts");

function enableWebgl2(): void {
  happy.HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    return kind === "webgl2" ? {} as WebGL2RenderingContext : null;
  }) as typeof happy.HTMLCanvasElement.prototype.getContext;
}

class FakeWebgl {
  listener: (() => void) | null = null;

  activate(): void {}
  dispose(): void {}
  onContextLoss(listener: () => void): { dispose: () => void } {
    this.listener = listener;
    return { dispose: () => { this.listener = null; } };
  }
}

afterEach(() => {
  happy.HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("complete-terminal renderer", () => {
  test("releases the temporary WebGL2 capability context", () => {
    let lost = 0;
    happy.HTMLCanvasElement.prototype.getContext = ((kind: string) => {
      if (kind !== "webgl2") return null;
      return {
        getExtension(name: string) {
          return name === "WEBGL_lose_context" ? { loseContext: () => lost++ } : null;
        },
      } as unknown as WebGL2RenderingContext;
    }) as typeof happy.HTMLCanvasElement.prototype.getContext;

    expect(supportsWebgl2()).toBeTrue();
    expect(lost).toBe(1);
  });

  test("loads WebGL before opening and forwards context loss", () => {
    enableWebgl2();
    const mount = document.createElement("div");
    const calls: string[] = [];
    let addon: FakeWebgl | null = null;
    let losses = 0;
    const terminal: RendererTerminal = {
      loadAddon(value: ITerminalAddon) {
        calls.push("load");
        addon = value as FakeWebgl;
      },
      open(parent: HTMLElement) {
        calls.push("open");
        const screen = document.createElement("div");
        screen.className = "xterm-screen";
        screen.append(document.createElement("canvas"));
        parent.append(screen);
      },
    };

    openWebglTerminal(terminal, FakeWebgl, mount, () => losses++);
    addon?.listener?.();

    expect(calls).toEqual(["load", "open"]);
    expect(losses).toBe(1);
  });

  test("rejects xterm's silent DOM fallback", () => {
    enableWebgl2();
    const mount = document.createElement("div");
    const terminal: RendererTerminal = {
      loadAddon() {},
      open(parent: HTMLElement) {
        const rows = document.createElement("div");
        rows.className = "xterm-rows";
        parent.append(rows);
      },
    };

    expect(() => openWebglTerminal(terminal, FakeWebgl, mount, () => undefined))
      .toThrow(WEBGL_UNAVAILABLE);
  });

  test("uses the actual addon result instead of allocating a second capability context", () => {
    happy.HTMLCanvasElement.prototype.getContext = (() => null) as typeof happy.HTMLCanvasElement.prototype.getContext;
    const mount = document.createElement("div");
    let opened = false;
    const terminal: RendererTerminal = {
      loadAddon() {},
      open() { opened = true; },
    };
    expect(() => openWebglTerminal(terminal, FakeWebgl, mount, () => undefined)).toThrow(WEBGL_UNAVAILABLE);
    expect(opened).toBeTrue();
  });

  test("keeps the strict terminal cell and color configuration together", () => {
    const linkHandler = { activate: () => undefined };
    const fontFamily = 'ui-monospace, "SF Mono", monospace';
    const options = fullTerminalOptions({ fontFamily, fontSize: 13, lineHeight: 1.5, linkHandler });
    expect(options).toMatchObject({
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false,
      customGlyphs: true,
      fontSize: 13,
      lineHeight: 1.5,
      letterSpacing: 0,
      scrollback: 0,
      linkHandler,
    });
    expect(options.fontFamily).toBe(fontFamily);
    expect(options.theme).toMatchObject({ background: "#090c10", foreground: "#e7ebf1" });
  });
});
