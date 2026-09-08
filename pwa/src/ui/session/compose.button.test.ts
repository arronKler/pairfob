import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "../react/root";

const { setRenderer } = await import("../../paint");
const { app, clearNotice, paneComposeLive, setPaneComposeLive, state } = await import("../../state.ts");
const { setLang, t } = await import("../../lib/i18n.ts");
const { flushLiveInput, handlePaneKey, sendPad, setComposeLive, submitTyped } = await import("./compose.ts");
const { dropQueuedKeys, flushKeys } = await import("./keys.ts");
const { SessionCompose } = await import("../react/session-compose.tsx");

function paint(): void {
  renderReactScreen(createElement(SessionCompose, { includeBack: false }));
}

function mount(draft: string, live = false): HTMLButtonElement {
  state.composeDraft = draft;
  state.composeLive = live;
  act(() => { paint(); });
  const button = app.querySelector(".send-btn");
  if (!(button instanceof HTMLButtonElement)) throw new Error("missing compose Enter");
  return button;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setLang("zh");
  setRenderer(() => {});
  Object.assign(state, {
    phase: "live", screen: "home", paneId: "", paneText: "", paneHash: "", live: null,
    agents: [], fullTerminal: false, agentChat: false, operationBusy: false,
    composeDraft: "", composeLive: false, composeIME: false, composeFocused: false,
    defaultComposeLive: false, paneComposeLive: {}, keysExpanded: false, padKind: "keys",
    termSelect: false, termWrap: false, paneRow: null, paneFollow: true, paneUnread: false,
  });
  clearNotice();
});

afterEach(async () => {
  await act(async () => { await flushLiveInput(); });
  await act(() => leaveReactScreen());
  dropQueuedKeys();
  state.composeDraft = "";
  state.composeLive = false;
  state.defaultComposeLive = false;
  state.paneComposeLive = {};
  state.live = null;
  state.paneId = "";
  state.paneText = "";
  state.screen = "home";
  clearNotice();
  setRenderer(() => {});
  app.replaceChildren();
});

describe("compose trailing Enter", () => {
  const lifted = [
    "╭──────────────────────────────────────────────────╮",
    "│ Edit file                                        │",
    "│                                                  │",
    "│ Do you want to make this edit to config.ts?      │",
    "│ ❯ 1. Yes                                         │",
    "│   2. Yes, allow all edits this session           │",
    "│   3. No, and tell Claude what to do differently  │",
    "╰──────────────────────────────────────────────────╯",
    "",
    "  esc to interrupt · ? for shortcuts",
  ].join("\n");

  test("empty Enter stays available on ordinary and confirmation screens", () => {
    state.paneText = "Delete everything? [Y/n]";
    const open = mount("");
    expect(open.disabled).toBe(false);
    expect(open.textContent).toBe("Enter");
    expect(open.getAttribute("aria-label")).toBe("向终端发送 Enter");

    state.paneText = lifted;
    const prompt = mount("");
    expect(prompt.disabled).toBe(false);
    expect(prompt.getAttribute("aria-label")).toBe("向终端发送 Enter");
    expect(mount("run tests").disabled).toBe(false);
  });

  test("live mode keeps an empty trailing Enter", () => {
    const button = mount("", true);
    expect(button.textContent).toBe("Enter");
    expect(button.disabled).toBe(false);
  });

  test("selecting live input stays in the guided view and belongs only to the active pane", async () => {
    state.paneId = "p1";
    state.screen = "pane";
    state.live = { isConnected: () => true } as typeof state.live;
    mount("");

    await act(async () => { await setComposeLive(true); });

    expect(state.composeLive).toBeTrue();
    expect(state.fullTerminal).toBeFalse();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
  });

  test("a delayed mode flush cannot overwrite the next pane's input mode", async () => {
    let finishSend!: () => void;
    state.paneId = "p1";
    state.screen = "pane";
    state.live = {
      isConnected: () => true,
      sendText: () => new Promise<void>((resolve) => { finishSend = resolve; }),
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    const view = app.ownerDocument.defaultView!;
    act(() => {
      input.value = "one";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    let changing!: Promise<void>;
    act(() => { changing = setComposeLive(false); });
    await act(async () => { await Promise.resolve(); });
    state.paneId = "p2";
    state.composeLive = true;
    setPaneComposeLive("p2", true);
    await act(async () => { finishSend(); await changing; });

    expect(state.composeLive).toBeTrue();
    expect(paneComposeLive("p1")).toBeFalse();
    expect(paneComposeLive("p2")).toBeTrue();
  });

  test("live input is visible locally before the network flush", async () => {
    const sent: string[] = [];
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendText: async (_paneId: string, text: string) => {
        sent.push(text);
      },
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    const form = app.querySelector(".dock-form");
    if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLElement)) throw new Error("missing live compose");
    const view = app.ownerDocument.defaultView!;

    act(() => {
      input.value = "hello";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("本机待回显 · hello");
    expect(form.classList.contains("live-pending")).toBeTrue();
    expect(form.querySelector(".live-input-status")?.textContent).toBe(t("compose.pendingStatus", { n: 5 }));
    expect(sent).toEqual([]);

    expect(await act(() => flushLiveInput())).toBeTrue();
    expect(sent).toEqual(["hello"]);
    expect(input.placeholder).toBe("实时 · 边打边进终端");
  });

  test("a failed live mutation pauses live mode and restores text for deliberate retry", async () => {
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendText: async () => { throw new Error("not sent"); },
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    const view = app.ownerDocument.defaultView!;
    act(() => {
      input.value = "retry me";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    expect(await act(() => flushLiveInput())).toBeFalse();
    expect(state.composeLive).toBeFalse();
    expect(state.composeDraft).toBe("retry me");
    expect(input.value).toBe("retry me");
  });

  test("a deliberate keyboard Enter remains available outside the trailing button", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    mount("");

    const view = app.ownerDocument.defaultView!;
    const event = new view.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    await act(async () => { handlePaneKey(event, true); await flushKeys(); });

    expect(event.defaultPrevented).toBe(true);
    expect(sent).toEqual([["enter"]]);
  });

  test("the trailing button and keypad both send a bare Enter", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    const button = mount("");

    await act(async () => { await submitTyped(true); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    await act(() => { button.click(); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    await act(async () => { await sendPad("enter"); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);
  });

  test("a confirmation screen receives the same deliberate Enter as any TUI", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.paneText = lifted;
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    mount("");

    await act(async () => { await submitTyped(true); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);
  });
});
