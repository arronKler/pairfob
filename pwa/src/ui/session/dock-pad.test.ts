import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "../react/root";

const { setLang } = await import("../../lib/i18n");
const { app, clearNotice, state } = await import("../../state.ts");
const { setRenderer } = await import("../../paint.ts");
const { SLASH_COMMANDS } = await import("../../lib/slash-commands.ts");
const { SessionDock, SessionKeyPad } = await import("../react/session-dock.tsx");

function paintDock(): void {
  renderReactScreen(createElement(SessionDock, { includeBack: true }));
}

function paintPad(): void {
  renderReactScreen(createElement(SessionKeyPad));
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
  await act(() => leaveReactScreen());
  state.keysExpanded = false;
  state.padKind = "keys";
  state.composeIME = false;
  state.composeFocused = false;
  state.composeDraft = "";
  setRenderer(() => undefined);
  clearNotice();
  setRenderer(() => {});
  app.replaceChildren();
});

describe("session pad morphs", () => {
  test("expanding and switching pad modes preserves the same focused IME field and selection", async () => {
    state.keysExpanded = false;
    state.padKind = "keys";
    await act(() => { paintDock(); });
    const input = app.querySelector("textarea")!;
    const view = app.ownerDocument.defaultView!;
    let repaints = 0;
    setRenderer(() => { repaints++; });
    input.value = "正在编辑的文字";
    input.focus();
    input.setSelectionRange(1, 4);
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    const tap = async (button: HTMLButtonElement) => {
      const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
      act(() => { button.dispatchEvent(down); });
      expect(down.defaultPrevented).toBe(true);
      await act(() => { button.click(); });
      expect(app.querySelector("textarea") === input).toBeTrue();
      expect(document.activeElement === input).toBeTrue();
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
      expect(input.value).toBe("正在编辑的文字");
      expect(state.composeIME).toBe(true);
    };
    await tap(app.querySelector(".key-more")!);
    expect(state.keysExpanded).toBe(true);
    await tap(app.querySelectorAll<HTMLButtonElement>(".pad-mode button")[1]!);
    expect(app.querySelector(".slash-pad")).toBeTruthy();
    await tap(app.querySelectorAll<HTMLButtonElement>(".pad-mode button")[0]!);
    expect(app.querySelector(".key-mod")).toBeTruthy();
    await tap(app.querySelector(".key-more")!);
    expect(state.keysExpanded).toBe(false);
    expect(repaints).toBe(0);
  });

  test("collapsed pad keeps only the TUI survival row", async () => {
    state.keysExpanded = false;
    await act(() => { paintPad(); });
    expect(app.querySelector(".pad-mode")).toBeNull();
    expect(app.querySelector(".slash-pad")).toBeNull();
    expect(app.querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
  });

  test("expanded keys still expose Tab, Enter and modifiers", async () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    await act(() => { paintPad(); });
    expect(app.querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
    expect(app.querySelector(".slash-pad")).toBeNull();
    expect(app.textContent).toContain("Tab");
    expect(app.textContent).toContain("Ctrl");
    expect(app.textContent).toContain("换行");
  });

  test("expanded command morph fills compose chips and not SendKeys", async () => {
    state.keysExpanded = true;
    state.padKind = "slash";
    await act(() => { paintPad(); });
    const chips = [...app.querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(app.textContent).not.toContain("Tab");
    expect(app.querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
  });
});
