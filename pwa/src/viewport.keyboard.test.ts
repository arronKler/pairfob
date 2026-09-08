import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

describe("software keyboard coordination", () => {
  test("keyboard state is published once the inset stops moving, not on every frame", async () => {
    const happy = new Window({ width: 390, height: 844 });
    const viewport = Object.assign(new happy.EventTarget(), { scale: 1, height: 844, offsetTop: 0 });
    Object.defineProperty(happy, "visualViewport", { value: viewport });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window = happy;
    globals.document = happy.document;
    happy.scrollTo = () => undefined;
    const { bindVisualViewport, keyboardIsOpen } = await import("./viewport?keyboard");
    const flips: boolean[] = [];
    bindVisualViewport(() => undefined, (open) => flips.push(open));
    const send = () => viewport.dispatchEvent(new happy.Event("resize"));
    const settle = () => new Promise((done) => setTimeout(done, 140));

    // iOS reports the keyboard arriving over several frames.
    viewport.height = 700;
    send();
    viewport.height = 520;
    send();
    viewport.height = 500;
    send();
    expect(flips).toEqual([]);
    await settle();
    expect(flips).toEqual([true]);
    expect(keyboardIsOpen()).toBeTrue();
    expect(happy.document.documentElement.dataset.kb).toBe("open");

    viewport.height = 844;
    send();
    await settle();
    expect(flips).toEqual([true, false]);
    expect(happy.document.documentElement.dataset.kb).toBe("closed");
  });

  test("a browser toolbar hiding is not a keyboard", async () => {
    const happy = new Window({ width: 390, height: 844 });
    const viewport = Object.assign(new happy.EventTarget(), { scale: 1, height: 844, offsetTop: 0 });
    Object.defineProperty(happy, "visualViewport", { value: viewport });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window = happy;
    globals.document = happy.document;
    happy.scrollTo = () => undefined;
    const { bindVisualViewport } = await import("./viewport?toolbar");
    const flips: boolean[] = [];
    bindVisualViewport(() => undefined, (open) => flips.push(open));

    viewport.height = 780;
    viewport.dispatchEvent(new happy.Event("resize"));
    await new Promise((done) => setTimeout(done, 140));
    expect(flips).toEqual([]);
  });
});

describe("the row being typed into stays visible", () => {
  test("the keyboard opening reveals the caret row and closing leaves scroll alone", async () => {
    const main = await Bun.file(new URL("./main.ts", import.meta.url)).text();
    const term = await Bun.file(new URL("./ui/session/term.ts", import.meta.url)).text();
    expect(main).toContain("if (!open ||");
    expect(main).toContain("requestAnimationFrame(revealCaretRow)");
    const reveal = term.slice(term.indexOf("export function revealCaretRow"));
    expect(reveal).toContain("if (wanted <= term.scrollTop) return;");
    expect(reveal).toContain("row * 2");
  });

  test("the dock settle rides on the settled state, never on the shell height", async () => {
    const dock = await Bun.file(new URL("./styles/dock.scss", import.meta.url)).text();
    const shell = await Bun.file(new URL("./styles/session-shell.scss", import.meta.url)).text();
    expect(dock).toContain('html[data-kb="open"] .dock { animation: dock-settle');
    expect(shell).not.toMatch(/#app\.session\s*\{[^}]*transition/);
  });
});
