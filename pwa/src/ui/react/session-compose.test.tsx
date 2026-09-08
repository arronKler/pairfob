import { act } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "./root";
const { app, paneComposeLive, setPaneComposeLive, state } = await import("../../state");
const { setLang, t } = await import("../../lib/i18n");
const { composeField, composeViewSnapshot, flushLiveInput, setComposeLive } = await import("../session/compose");
const { SessionCompose, SessionDock } = await import("./session-dock");

function paint(includeBack = false) {
  renderReactScreen(<SessionDock includeBack={includeBack} />);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(async () => {
  await act(async () => { await flushLiveInput(); });
  await act(() => leaveReactScreen());
  state.composeDraft = "";
  state.composeLive = false;
  state.defaultComposeLive = false;
  state.paneComposeLive = {};
  state.composeIME = false;
  state.composeFocused = false;
  state.live = null;
  state.paneId = "";
  state.keysExpanded = false;
  state.padKind = "keys";
  app.replaceChildren();
});

describe("React session compose", () => {
  test("keeps the same field, IME, draft and selection across output paints and keypad toggle", async () => {
    await act(() => { paint(true); });
    const input = app.querySelector("textarea")!;
    const view = app.ownerDocument.defaultView!;
    input.value = "正在编辑的文字";
    act(() => input.focus());
    input.setSelectionRange(1, 4);
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    expect(app.querySelector("textarea")?.id).toBe("compose-text-mobile");
    await act(() => { paint(true); });
    expect(app.querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(input.value).toBe("正在编辑的文字");
    const more = app.querySelector<HTMLButtonElement>(".key-more")!;
    const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    more.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(() => { more.click(); });
    expect(state.keysExpanded).toBe(true);
    expect(app.querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(state.composeIME).toBe(true);
  });

  test("live input is visible locally before the network flush", async () => {
    const sent: string[] = [];
    state.paneId = "p1";
    state.screen = "home";
    state.composeLive = true;
    state.live = {
      isConnected: () => true,
      sendText: async (_paneId: string, text: string) => { sent.push(text); },
    } as typeof state.live;
    await act(() => { paint(); });
    const input = app.querySelector("textarea")!;
    const form = app.querySelector(".dock-form")!;
    const view = app.ownerDocument.defaultView!;
    // flushSync paints the pending snapshot without running the pump's next frame.
    act(() => flushSync(() => {
      input.value = "hello";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    }));
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("本机待回显 · hello");
    expect(form.classList.contains("live-pending")).toBeTrue();
    expect(form.querySelector(".live-input-status")?.textContent).toBe(t("compose.pendingStatus", { n: 5 }));
    expect(sent).toEqual([]);
    expect(await act(() => flushLiveInput())).toBeTrue();
    expect(sent).toEqual(["hello"]);
    expect(input.placeholder).toBe("实时 · 边打边进终端");
  });

  test("desktop field id stays the full-terminal-compatible compose selector", async () => {
    await act(() => { paint(false); });
    expect(app.querySelector("textarea")?.id).toBe("compose-text-desktop");
    expect(app.querySelector(".full-terminal-compose-input")).toBeNull();
    expect(app.querySelector(".dock-form textarea")).toBeTruthy();
  });

  test("selecting live input stays in the guided view and belongs only to the active pane", async () => {
    state.paneId = "p1";
    state.screen = "pane";
    state.live = { isConnected: () => true } as typeof state.live;
    await act(() => { paint(); });
    await act(async () => { await setComposeLive(true); });
    expect(state.composeLive).toBeTrue();
    expect(state.fullTerminal).toBeFalse();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
    expect(app.querySelector(".dock-form")?.classList.contains("live")).toBeTrue();
  });

  test("composeField still prefers a full-terminal consumer over the dock", async () => {
    await act(() => { paint(); });
    const full = app.ownerDocument.createElement("textarea");
    full.className = "full-terminal-compose-input";
    app.append(full);
    expect(composeField()).toBe(full);
    expect(app.querySelector(".dock-form textarea")).not.toBe(full);
  });

  test("the view snapshot does not create a live pump", async () => {
    const view = app.ownerDocument.defaultView!;
    const orig = view.requestAnimationFrame.bind(view);
    let frames = 0;
    view.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames++;
      return orig(cb);
    }) as typeof view.requestAnimationFrame;
    try {
      composeViewSnapshot();
      expect(frames).toBe(0);
      expect(composeViewSnapshot().pendingText).toBe("");
    } finally {
      view.requestAnimationFrame = orig;
    }
  });

  test("unmount disposes field listeners so a detached input cannot enqueue", async () => {
    state.paneId = "p1";
    state.composeLive = true;
    state.live = {
      isConnected: () => true,
      sendText: async () => undefined,
    } as typeof state.live;
    await act(() => { paint(); });
    const input = app.querySelector("textarea")!;
    const view = app.ownerDocument.defaultView!;
    await act(() => leaveReactScreen());
    input.value = "stale";
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    expect(composeViewSnapshot().pendingText).toBe("");
    expect(state.composeDraft).toBe("");
  });
});

void SessionCompose;
void setPaneComposeLive;
