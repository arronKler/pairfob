import { act } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
import { appRoot } from "../../../app/dom-root";
const { setScreen } = await import("../../../app/navigation-store.ts");
const { setLang, t } = await import("../../../lib/i18n");
const { composeDraft, composeFocused, composeIME, composeLive, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } = await import("../compose-store");
const { keysExpanded, paneComposeLive, setDefaultComposeLive, setKeysExpanded, setPadKind } = await import("../../settings/preferences-store");
const { isFullTerminal, selectPane } = await import("../session-store");
const { attachLiveSession } = await import("../../computers/catalog-store");
const { composeField, composeViewSnapshot, flushLiveInput, setComposeLive: guidedSetComposeLive } = await import("./compose");
const { SessionDock } = await import("./session-dock");
import type { LiveSession } from "../../../lib/protocol/session-types";

/** Restore the one per-pane compose choice this fixture persists (guided mode). */
const paneComposeRestorer = new PaneComposePreferenceRestorer();

function paint(includeBack = false) {
  renderReact(<SessionDock includeBack={includeBack} />);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  paneComposeRestorer.capture("p1");
});

afterEach(async () => {
  await act(async () => { await flushLiveInput(); });
  unmountReact();
  setComposeDraft("");
  setComposeLive(false);
  setDefaultComposeLive(false);
  paneComposeRestorer.restore("p1");
  setComposeIME(false);
  setComposeFocused(false);
  attachLiveSession(null);
  selectPane("");
  setKeysExpanded(false);
  setPadKind("keys");
  appRoot().replaceChildren();
});

describe("React session compose", () => {
  test("keeps the same field, IME, draft and selection across output paints and keypad toggle", async () => {
    await act(() => { paint(true); });
    const input = appRoot().querySelector("textarea")!;
    const view = appRoot().ownerDocument.defaultView!;
    input.value = "正在编辑的文字";
    act(() => input.focus());
    input.setSelectionRange(1, 4);
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    expect(appRoot().querySelector("textarea")?.id).toBe("compose-text-mobile");
    await act(() => { paint(true); });
    expect(appRoot().querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(input.value).toBe("正在编辑的文字");
    const more = appRoot().querySelector<HTMLButtonElement>(".key-more")!;
    const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    act(() => { more.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    await act(() => { more.click(); });
    expect(keysExpanded()).toBe(true);
    expect(appRoot().querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(composeIME()).toBe(true);
  });

  test("live input is visible locally before the network flush", async () => {
    const sent: string[] = [];
    selectPane("p1");
    setScreen("home");
    setComposeLive(true);
    attachLiveSession({
      isConnected: () => true,
      sendText: async (_paneId: string, text: string) => { sent.push(text); },
    } as unknown as LiveSession);
    await act(() => { paint(); });
    const input = appRoot().querySelector("textarea")!;
    const form = appRoot().querySelector(".dock-form")!;
    const view = appRoot().ownerDocument.defaultView!;
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
    expect(appRoot().querySelector("textarea")?.id).toBe("compose-text-desktop");
    expect(appRoot().querySelector(".full-terminal-compose-input")).toBeNull();
    expect(appRoot().querySelector(".dock-form textarea")).toBeTruthy();
  });

  test("selecting live input stays in the guided view and belongs only to the active pane", async () => {
    selectPane("p1");
    setScreen("pane");
    attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
    await act(() => { paint(); });
    await act(async () => { await guidedSetComposeLive(true); });
    expect(composeLive()).toBeTrue();
    expect(isFullTerminal()).toBeFalse();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
    expect(appRoot().querySelector(".dock-form")?.classList.contains("live")).toBeTrue();
  });

  test("composeField still prefers a full-terminal consumer over the dock", async () => {
    await act(() => { paint(); });
    const full = appRoot().ownerDocument.createElement("textarea");
    full.className = "full-terminal-compose-input";
    appRoot().append(full);
    expect(composeField()).toBe(full);
    expect(appRoot().querySelector(".dock-form textarea")).not.toBe(full);
  });

  test("the view snapshot does not create a live pump", async () => {
    const view = appRoot().ownerDocument.defaultView!;
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
    selectPane("p1");
    setComposeLive(true);
    attachLiveSession({
      isConnected: () => true,
      sendText: async () => undefined,
    } as unknown as LiveSession);
    await act(() => { paint(); });
    const input = appRoot().querySelector("textarea")!;
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => { unmountReact(); });
    input.value = "stale";
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    expect(composeViewSnapshot().pendingText).toBe("");
    expect(composeDraft()).toBe("");
  });
});