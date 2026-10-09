import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { applySnapshot as seedPadSnapshot } from "../../dashboard/catalog-store";
import { selectPane as selectPadPane } from "../session-store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { composeDraft, setComposeLive } from "../compose-store";
import { keysExpanded, padKind, setKeysExpanded, setPadKind } from "../../settings/preferences-store";

const kindOption = (label: string) =>
  [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-kind-option")].find((el) => el.textContent === label)!;
const { bindXtermKeyboard, encodeTerminalKey, httpUrlsInLine, notifyFullTerminalKeyboard, openTerminalLink, tapAsMouse } = await import("./full-terminal-input.ts");
const { FullTerminalPad } = await import("./full-terminal-pad.tsx");

beforeEach(resetBoardTestDOM);
afterEach(async () => {
  unmountReact();
  notifyFullTerminalKeyboard(false);
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeLive(false);
  appRoot().replaceChildren();
});

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
  /** xterm's own nesting: the element its mouse protocol listens on, around the screen its link layer listens on. */
  function surface() {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    xterm.append(screen);
    host.append(xterm);
    // A 320×480 screen at the page origin.
    screen.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480, x: 0, y: 0 }) as DOMRect;
    const seen = (el: HTMLElement): Array<{ type: string; x: number; y: number; buttons: number }> => {
      const received: Array<{ type: string; x: number; y: number; buttons: number }> = [];
      for (const type of ["mousemove", "mousedown", "mouseup", "mouseleave"] as const) {
        el.addEventListener(type, (event) => {
          const mouse = event as MouseEvent;
          received.push({ type, x: mouse.clientX, y: mouse.clientY, buttons: mouse.buttons });
        });
      }
      return received;
    };
    return { host, xterm, screen, onScreen: seen(screen), onXterm: seen(xterm) };
  }

  test("is a whole mouse press on the screen: from elsewhere onto the spot, down, up, and away", () => {
    const { host, onScreen } = surface();
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }));
    // The move is what tells xterm's link layer which link the press is on; the
    // one before it, from the far corner, makes it a move to a new cell; the
    // leave drops the hover a finger does not have.
    expect(onScreen).toEqual([
      { type: "mousemove", x: 319, y: 479, buttons: 0 },
      { type: "mousemove", x: 40, y: 80, buttons: 0 },
      { type: "mousedown", x: 40, y: 80, buttons: 1 },
      { type: "mouseup", x: 40, y: 80, buttons: 0 },
      { type: "mouseleave", x: 40, y: 80, buttons: 0 },
    ]);
    // A tap in the far half comes from the near corner instead.
    onScreen.length = 0;
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 300, clientY: 400, pointerType: "touch" }));
    expect(onScreen[0]).toEqual({ type: "mousemove", x: 1, y: 1, buttons: 0 });
  });

  test("reaches the element around the screen too, where the mouse protocol listens, without the move from elsewhere", () => {
    const { host, onXterm } = surface();
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }));
    // Everything but the leave, which is the screen's alone as a real one is. A
    // program tracking the mouse hears of the tap's spot and nowhere else.
    expect(onXterm).toEqual([
      { type: "mousemove", x: 40, y: 80, buttons: 0 },
      { type: "mousedown", x: 40, y: 80, buttons: 1 },
      { type: "mouseup", x: 40, y: 80, buttons: 0 },
    ]);
  });

  /**
   * xterm's Linkifier in miniature: it looks for the link under the pointer
   * only when a move reaches a new cell, opens the link a press began and ended
   * on, and on leave forgets the link but not the cell.
   */
  function linkLayer(screen: HTMLElement, link: { from: number; to: number }): { opened: number[]; hovered: () => boolean } {
    const opened: number[] = [];
    let cell = "";
    let hovered = false;
    let pressed = false;
    screen.addEventListener("mousemove", (event) => {
      const next = `${Math.floor(event.clientX / 8)},${Math.floor(event.clientY / 16)}`;
      if (next === cell) return;
      cell = next;
      hovered = event.clientX >= link.from && event.clientX <= link.to && event.clientY < 96;
    });
    screen.addEventListener("mousedown", () => { pressed = hovered; });
    screen.addEventListener("mouseup", (event) => { if (hovered && pressed) opened.push(event.clientX); });
    screen.addEventListener("mouseleave", () => { hovered = false; pressed = false; });
    return { opened, hovered: () => hovered };
  }

  test("a link layer like xterm's opens the link a tap lands on, and not one beside it", () => {
    const { host, screen } = surface();
    const { opened, hovered } = linkLayer(screen, { from: 30, to: 90 });
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }));
    expect(opened).toEqual([40]);
    expect(hovered()).toBeFalse();
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 200, clientY: 80, pointerType: "touch" }));
    expect(opened).toEqual([40]);
  });

  test("every tap on a URL opens it: a second and a third on the same cell too", () => {
    const { host, screen } = surface();
    const { opened } = linkLayer(screen, { from: 30, to: 90 });
    for (let tap = 0; tap < 3; tap++) {
      tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }));
    }
    expect(opened).toEqual([40, 40, 40]);
    // And in the screen's far half, where the move comes from the other corner.
    const far = linkLayer(screen, { from: 200, to: 310 });
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 300, clientY: 90, pointerType: "touch" }));
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 300, clientY: 90, pointerType: "touch" }));
    expect(far.opened).toEqual([300, 300]);
  });

  test("a press that was held clicks for a TUI and opens no link: it goes without the moves", () => {
    const { host, onScreen } = surface();
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 40, clientY: 80, pointerType: "touch" }), true);
    expect(onScreen.map((event) => event.type)).toEqual(["mousedown", "mouseup", "mouseleave"]);
  });

  test("before xterm has drawn a screen the press still lands on what there is", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    const types: string[] = [];
    xterm.addEventListener("mousedown", () => types.push("down"));
    xterm.addEventListener("mouseup", () => types.push("up"));
    tapAsMouse(host, new PointerEvent("pointerup", { clientX: 1, clientY: 1, pointerType: "touch" }));
    expect(types).toEqual(["down", "up"]);
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
    expectDifferentNode(document.activeElement, ta);
    kb.open();
    expect(ta.readOnly).toBe(false);
    expect(ta.getAttribute("inputmode")).toBeNull();
    expect(host.classList.contains("kb-on")).toBe(true);
    kb.close();
    expect(ta.readOnly).toBe(true);
    expectDifferentNode(document.activeElement, ta);
    kb.destroy();
    ta.focus();
    await Promise.resolve();
    expectSameNode(document.activeElement, ta);
    host.remove();
  });

  test("switched off, the helper textarea is not a Tab stop; open, it is the terminal's one again", () => {
    const host = document.createElement("div");
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    // As xterm leaves it.
    ta.tabIndex = 0;
    host.append(ta);
    document.body.append(host);
    // 组字: Tab from the header walks on to the dock without stopping on a field that gives focus back.
    const kb = bindXtermKeyboard(host, false);
    expect(ta.tabIndex).toBe(-1);
    kb.open();
    expect(ta.tabIndex).toBe(0);
    expectSameNode(document.activeElement, ta);
    kb.close();
    expect(ta.tabIndex).toBe(-1);
    kb.toggle();
    expect(ta.tabIndex).toBe(0);
    kb.destroy();
    host.remove();
  });

  test("a terminal that starts open leaves the caret where the reader is typing; asking for it takes it", () => {
    const host = document.createElement("div");
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    host.append(ta);
    const elsewhere = document.createElement("input");
    document.body.append(host, elsewhere);
    elsewhere.focus();
    // The session column may not take focus right now (the reader is in the list).
    const kb = bindXtermKeyboard(host, true, () => false);
    expect(kb.isOpen()).toBe(true);
    expect(ta.readOnly).toBe(false);
    expect(host.classList.contains("kb-on")).toBe(true);
    expectSameNode(document.activeElement, elsewhere);
    // An explicit open is the reader asking, wherever focus was.
    kb.open();
    expectSameNode(document.activeElement, ta);
    kb.destroy();
    host.remove();
    elsewhere.remove();
  });

  test("destroy drops the focus listener so a late microtask cannot retarget", async () => {
    const host = document.createElement("div");
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    host.append(ta);
    document.body.append(host);
    const kb = bindXtermKeyboard(host, false);
    ta.focus();
    kb.destroy();
    await Promise.resolve();
    expectSameNode(document.activeElement, ta);
    host.remove();
  });
});

describe("complete-terminal pad chrome", () => {
  test("shows esc and arrows, then more keys after expand", () => {
    setKeysExpanded(false);
    setPadKind("keys");
    const sent: string[] = [];
    renderReact(createElement(FullTerminalPad, {
      options: {
        sendKey: (key: string) => sent.push(key),
        sendCompose: () => true,
        keyboard: { toggle: () => undefined, open: () => undefined, close: () => undefined, isOpen: () => false },
        hardwareKeyboard: false,
      },
    }));
    const pad = appRoot();
    const labels = [...pad.querySelectorAll(".full-terminal-pad button")].map((el) => el.getAttribute("aria-label") || el.textContent);
    expect(labels.slice(0, 6)).toEqual(["Esc", "上箭头", "下箭头", "左箭头", "右箭头", "退格"]);
    expect(pad.querySelector('[aria-label="更多按键"]') !== null).toBeTrue();
    act(() => { (pad.querySelector('[aria-label="更多按键"]') as HTMLButtonElement).click(); });
    expect(keysExpanded()).toBe(true);
    const expanded = [...pad.querySelectorAll(".full-terminal-pad button")].map((el) => el.textContent);
    expect(pad.querySelector('[aria-label="Ctrl+C"]') !== null).toBeTrue();
    expect(expanded).toContain("Alt");
    expect(pad.textContent).toContain("Shift");
    expect(pad.textContent).toContain("Cmd");
    expect(pad.querySelector('[aria-label="Ctrl+W"]') !== null).toBeTrue();
    expect(kindOption("按键").getAttribute("aria-pressed")).toBe("true");
    (pad.querySelector('[aria-label="上箭头"]') as HTMLButtonElement).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(sent).toEqual(["up"]);
    act(() => { setKeysExpanded(false); });
  });

  test("expanded commands use the same switch and slash catalog as guided mode", () => {
    setKeysExpanded(true);
    setPadKind("keys");
    renderReact(createElement(FullTerminalPad, {
      options: {
        sendKey: () => undefined,
        sendCompose: () => true,
        keyboard: { toggle: () => undefined, open: () => undefined, close: () => undefined, isOpen: () => false },
        hardwareKeyboard: false,
      },
    }));
    const pad = appRoot();
    act(() => { kindOption("命令").click(); });
    expect(padKind()).toBe("slash");
    expect(kindOption("命令").getAttribute("aria-pressed")).toBe("true");
    act(() => { seedPadSnapshot({ panes: [{ pane_id: "shortcut-test", agent: "claude" }] }); selectPadPane("shortcut-test"); });
    act(() => { (pad.querySelector('[aria-label="插入 /clear"]') as HTMLButtonElement).click(); });
    // The command goes before the draft with one space after it (insertSlashCommand).
    expect(composeDraft()).toBe("/clear ");
    expect((pad.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("/clear ");
    act(() => { setKeysExpanded(false); setPadKind("keys"); });
  });

  test("the type field is a named control separate from scroll and pad keys", () => {
    let open = false;
    setComposeLive(true);
    renderReact(createElement(FullTerminalPad, {
      options: {
        sendKey: () => undefined,
        sendCompose: () => true,
        keyboard: {
          toggle: () => { open = !open; },
          open: () => { open = true; },
          close: () => { open = false; },
          isOpen: () => open,
        },
        hardwareKeyboard: false,
      },
    }));
    const kb = appRoot().querySelector(".full-terminal-kb") as HTMLButtonElement;
    expect(kb.textContent).toBe("点这里输入");
    expect(kb.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      kb.click();
    });
    expect(open).toBe(true);
    expect(kb.textContent).toBe("收起键盘");
  });
});
