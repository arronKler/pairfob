import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Node", "MouseEvent", "PointerEvent", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { bindXtermKeyboard, encodeTerminalKey, fullTerminalPad, httpUrlsInLine, openTerminalLink, tapAsMouse } = await import("./full-terminal-input.ts");
const { state } = await import("../state.ts");

describe("complete-terminal pad encoding", () => {
  test("arrow keys follow application cursor mode", () => {
    expect(encodeTerminalKey("esc")).toBe("\x1b");
    expect(encodeTerminalKey("up")).toBe("\x1b[A");
    expect(encodeTerminalKey("up", true)).toBe("\x1bOA");
    expect(encodeTerminalKey("down", true)).toBe("\x1bOB");
    expect(encodeTerminalKey("right", true)).toBe("\x1bOC");
    expect(encodeTerminalKey("left", true)).toBe("\x1bOD");
    expect(encodeTerminalKey("enter")).toBe("\r");
    expect(encodeTerminalKey("backspace")).toBe("\x7f");
    expect(encodeTerminalKey("ctrl+c")).toBe("\x03");
    expect(encodeTerminalKey("ctrl+z")).toBe("\x1a");
    expect(encodeTerminalKey("ctrl+a")).toBe("\x01");
    expect(encodeTerminalKey("ctrl+k")).toBe("\x0b");
    expect(encodeTerminalKey("A")).toBe("A");
    expect(encodeTerminalKey("nope")).toBe("");
  });
});

describe("complete-terminal links", () => {
  test("extracts http(s) URLs and strips trailing punctuation", () => {
    expect(httpUrlsInLine("see https://pairfob.com/pair.")).toEqual([
      { uri: "https://pairfob.com/pair", start: 4, end: 28 },
    ]);
    expect(httpUrlsInLine("http://127.0.0.1:8787/a and https://example.com/b")).toHaveLength(2);
    expect(httpUrlsInLine("ftp://not-this and javascript:alert(1)")).toEqual([]);
  });

  test("only opens http(s) links", () => {
    const opened: string[] = [];
    const original = window.open;
    (window as unknown as { open: typeof window.open }).open = ((url?: string | URL) => {
      opened.push(String(url));
      return { opener: "keep" } as unknown as Window;
    }) as typeof window.open;
    expect(openTerminalLink("https://pairfob.com/pair")).toBe(true);
    expect(openTerminalLink("javascript:alert(1)")).toBe(false);
    expect(openTerminalLink("not a url")).toBe(false);
    expect(opened).toEqual(["https://pairfob.com/pair"]);
    window.open = original;
  });
});

describe("complete-terminal touch tap", () => {
  test("synthesizes left-button mouse down/up on the xterm surface", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    const received: Array<{ type: string; x: number; buttons: number }> = [];
    for (const type of ["mousedown", "mouseup"] as const) {
      xterm.addEventListener(type, (event) => {
        const mouse = event as MouseEvent;
        received.push({ type, x: mouse.clientX, buttons: mouse.buttons });
      });
    }
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }));
    expect(received).toEqual([
      { type: "mousedown", x: 40, buttons: 1 },
      { type: "mouseup", x: 40, buttons: 0 },
    ]);
  });
});

describe("complete-terminal xterm keyboard gate", () => {
  test("scroll and chrome keep the helper textarea inert until the user asks to type", async () => {
    const host = document.createElement("div");
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    host.append(ta);
    document.body.append(host);
    const kb = bindXtermKeyboard(host, false);
    expect(ta.readOnly).toBe(true);
    expect(ta.getAttribute("inputmode")).toBe("none");
    expect(host.classList.contains("kb-off")).toBe(true);
    ta.focus();
    await Promise.resolve();
    expect(document.activeElement === ta).toBe(false);
    kb.open();
    expect(ta.readOnly).toBe(false);
    expect(ta.getAttribute("inputmode")).toBeNull();
    expect(host.classList.contains("kb-on")).toBe(true);
    kb.close();
    expect(ta.readOnly).toBe(true);
    expect(document.activeElement === ta).toBe(false);
    host.remove();
  });
});

describe("complete-terminal pad chrome", () => {
  test("shows esc and arrows, then more keys after expand", () => {
    state.keysExpanded = false;
    const sent: string[] = [];
    const pad = fullTerminalPad((key) => sent.push(key));
    document.body.append(pad);
    const labels = [...pad.querySelectorAll("button")].map((el) => el.textContent);
    expect(labels.slice(0, 6)).toEqual(["Esc", "↑", "↓", "←", "→", "⌫"]);
    expect(pad.querySelector('[aria-label="更多按键"]')).toBeTruthy();
    (pad.querySelector('[aria-label="更多按键"]') as HTMLButtonElement).click();
    expect(state.keysExpanded).toBe(true);
    const expanded = [...pad.querySelectorAll("button")].map((el) => el.textContent);
    expect(expanded).toContain("Ctrl+C");
    expect(expanded).toContain("Opt");
    expect(expanded).toContain("Shift");
    expect(expanded).toContain("Cmd");
    expect(expanded).toContain("Ctrl+A");
    (pad.querySelector('[aria-label="上箭头"]') as HTMLButtonElement).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(sent).toEqual(["up"]);
    pad.remove();
    state.keysExpanded = false;
  });

  test("the type field is a named control separate from scroll and pad keys", () => {
    let open = false;
    const pad = fullTerminalPad(() => undefined, {
      toggle: () => {
        open = !open;
      },
      isOpen: () => open,
    });
    document.body.append(pad);
    const kb = pad.querySelector(".full-terminal-kb") as HTMLButtonElement;
    expect(kb.textContent).toBe("点这里输入");
    expect(kb.getAttribute("aria-pressed")).toBe("false");
    kb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    expect(open).toBe(true);
    expect(kb.textContent).toBe("收起键盘");
    pad.remove();
  });
});
