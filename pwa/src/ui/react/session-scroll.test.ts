import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { app, state } from "../../state";
import { bindPaneRefresh } from "../../pane-refresh-request";
import { sendPage, syncPagePending } from "../session/keys";
import { guidedScrollController } from "../session/guided-scroll";
import { pageScrollLines, sendGuidedTuiScroll } from "../session/term";
import { SessionScrollRail } from "./session-scroll";
import { SessionTerminal } from "./session-terminal";

beforeEach(resetBoardTestDOM);

const g = globalThis as unknown as Record<string, unknown>;
g.KeyboardEvent = happy.KeyboardEvent;
g.TouchEvent = happy.TouchEvent;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pointer(type: string, x = 10, y = 10): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function live(extra: Record<string, unknown> = {}) {
  return {
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    close: () => undefined,
    ...extra,
  };
}

afterEach(() => {
  guidedScrollController.dispose();
  bindPaneRefresh(async () => null);
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.fullTerminal = false;
  unmountReact();
  app.replaceChildren();
});

describe("react session scroll rail", () => {
  test("outer arrows send mouse-wheel TerminalScroll instead of cursor keys", async () => {
    const scrolls: Array<Record<string, unknown>> = [];
    const keys: string[][] = [];
    state.phase = "live";
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "ready";
    state.fullTerminal = false;
    state.live = live({
      sendKeys: async (_paneId: string, batch: string[]) => {
        keys.push(batch);
      },
      terminalOpen: async (paneId: string, cols: number, rows: number) => ({
        operationId: "op_open",
        terminalId: "term_00000000000000000000000000000000",
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      }),
      terminalScroll: async (terminalId: string, sequence: number, direction: string, lines: number, source: string) => {
        scrolls.push({ terminalId, sequence, direction, lines, source });
      },
      terminalClose: async () => undefined,
    });
    renderReact(createElement(SessionTerminal));
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const wheelUp = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向上");
    const wheelDown = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向下");
    if (!wheelUp || !wheelDown) throw new Error("missing wheel buttons");
    wheelUp.dispatchEvent(pointer("pointerdown"));
    wheelDown.dispatchEvent(pointer("pointerdown"));
    await wait(20);
    expect(scrolls).toEqual([
      { terminalId: "term_00000000000000000000000000000000", sequence: 1, direction: "up", lines: 3, source: "wheel" },
      { terminalId: "term_00000000000000000000000000000000", sequence: 2, direction: "down", lines: 3, source: "wheel" },
    ]);
    expect(keys).toEqual([]);
  });

  test("上一页 / 下一页 write CSI into the PTY, not SendKeys pageup", async () => {
    const texts: string[] = [];
    const keys: string[][] = [];
    state.phase = "live";
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "before";
    state.paneHash = "old";
    state.fullTerminal = false;
    state.live = live({
      sendText: async (_paneId: string, text: string) => {
        texts.push(text);
      },
      sendKeys: async (_paneId: string, batch: string[]) => {
        keys.push(batch);
      },
      paneRead: async () => ({ text: state.paneText, hash: "h" }),
    });
    bindPaneRefresh(async () => ({
      paneId: "p1",
      text: "after",
      hash: "new",
      changed: true,
      startedAt: performance.now(),
      completedAt: performance.now(),
    }));
    renderReact(createElement(SessionTerminal));
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const pageUp = rail.find((el) => el.getAttribute("aria-label") === "上一页");
    const pageDown = rail.find((el) => el.getAttribute("aria-label") === "下一页");
    if (!pageUp || !pageDown) throw new Error("missing page buttons");
    act(() => {
      pageUp.dispatchEvent(pointer("pointerdown"));
      pageDown.dispatchEvent(pointer("pointerdown"));
    });
    await act(async () => { await wait(40); });
    expect(texts).toEqual(["\u001b[5~", "\u001b[6~"]);
    expect(keys).toEqual([]);
  });

  test("page-pending subscription updates both React rails without DOM patching", async () => {
    const mutation = deferred<void>();
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "before";
    state.paneHash = "old";
    state.fullTerminal = false;
    state.live = live({
      sendText: async () => mutation.promise,
    });
    bindPaneRefresh(async () => ({
      paneId: "p1",
      text: "after",
      hash: "new",
      changed: true,
      startedAt: performance.now(),
      completedAt: performance.now(),
    }));
    renderReact(createElement(Fragment, null,
      createElement(SessionScrollRail, { scroll: sendGuidedTuiScroll, pageLines: pageScrollLines }),
      createElement(SessionScrollRail, { scroll: sendGuidedTuiScroll, pageLines: pageScrollLines }),
    ));
    const secondBtn = app.querySelectorAll<HTMLElement>(".scroll-page-up")[1];
    let page!: Promise<void>;
    act(() => {
      page = sendPage("up");
    });
    await act(async () => {
      await Promise.resolve();
    });
    const reactBtn = app.querySelector(".scroll-page-up") as HTMLElement;
    expect(reactBtn.closest("[data-react-session-scroll]")).toBeTruthy();
    expect(reactBtn.getAttribute("aria-busy")).toBe("true");
    expect(reactBtn.classList.contains("is-pending")).toBeTrue();
    expect(app.querySelector("[data-react-session-scroll]")?.getAttribute("aria-busy")).toBe("true");
    expect(secondBtn.getAttribute("aria-busy")).toBe("true");
    act(syncPagePending);
    expect(reactBtn.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      mutation.resolve();
      await page;
      await Promise.resolve();
    });
    expect(reactBtn.hasAttribute("aria-busy")).toBeFalse();
    expect(secondBtn.hasAttribute("aria-busy")).toBeFalse();
  });

  test("unmount cancels rail hold repeats immediately", async () => {
    const calls: Array<{ direction: string; lines: number; source: string }> = [];
    renderReact(
      createElement(SessionScrollRail, {
        scroll: (direction, lines, source) => {
          calls.push({ direction, lines, source });
        },
        pageLines: () => 19,
      }),
    );
    const up = app.querySelector(".scroll-up") as HTMLButtonElement;
    up.dispatchEvent(pointer("pointerdown"));
    expect(calls).toEqual([{ direction: "up", lines: 3, source: "wheel" }]);
    unmountReact();
    await wait(520);
    expect(calls).toEqual([{ direction: "up", lines: 3, source: "wheel" }]);
  });

  test("keyboard Space fires once without duplicating a pointer click", () => {
    const calls: Array<{ direction: string; lines: number; source: string }> = [];
    renderReact(
      createElement(SessionScrollRail, {
        scroll: (direction, lines, source) => {
          calls.push({ direction, lines, source });
        },
        pageLines: () => 19,
      }),
    );
    const [lineUp, pageUp] = [...app.querySelectorAll("button")] as HTMLButtonElement[];
    lineUp.dispatchEvent(pointer("pointerdown"));
    lineUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    pageUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    const spaceDown = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const spaceRepeat = new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true, cancelable: true });
    const spaceUp = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    lineUp.dispatchEvent(spaceDown);
    lineUp.dispatchEvent(spaceRepeat);
    lineUp.dispatchEvent(spaceUp);
    expect(calls).toEqual([
      { direction: "up", lines: 3, source: "wheel" },
      { direction: "up", lines: 19, source: "page_key" },
      { direction: "up", lines: 3, source: "wheel" },
    ]);
    expect(spaceDown.defaultPrevented).toBeTrue();
    expect(spaceRepeat.defaultPrevented).toBeTrue();
    expect(spaceUp.defaultPrevented).toBeTrue();
  });
});
