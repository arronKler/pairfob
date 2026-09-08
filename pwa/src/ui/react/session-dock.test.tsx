import { act } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { attachHappyDom, leaveReactScreen, renderReactScreen } from "../../../test-support/react-dom";

const happy = attachHappyDom();
const { app, state } = await import("../../state");
const { SLASH_COMMANDS } = await import("../../lib/slash-commands");
const { clearModifiers } = await import("../keypad");
const { SessionDock } = await import("./session-dock");

function paint() {
  renderReactScreen(app, <SessionDock includeBack />);
}

afterEach(async () => {
  await act(() => leaveReactScreen());
  clearModifiers();
  state.keysExpanded = false;
  state.padKind = "keys";
  state.composeIME = false;
  state.composeFocused = false;
  state.composeDraft = "";
  app.replaceChildren();
});

describe("React session dock", () => {
  test("collapsed pad keeps only the TUI survival row", async () => {
    state.keysExpanded = false;
    await act(() => { paint(); });
    expect(app.querySelector(".pad-mode")).toBeNull();
    expect(app.querySelector(".slash-pad")).toBeNull();
    expect(app.querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
    expect(app.querySelector(".dock-form textarea")).toBeTruthy();
  });

  test("expanded keys still expose Tab, Enter and modifiers", async () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    await act(() => { paint(); });
    expect(app.querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
    expect(app.querySelector(".slash-pad")).toBeNull();
    expect(app.textContent).toContain("Tab");
    expect(app.textContent).toContain("Ctrl");
    expect(app.textContent).toContain("换行");
  });

  test("expanded command morph fills compose chips and not SendKeys", async () => {
    state.keysExpanded = true;
    state.padKind = "slash";
    await act(() => { paint(); });
    const chips = [...app.querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(app.querySelector(".keys-wrap")?.textContent).not.toContain("Tab");
    expect(app.querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
  });

  test("expanding and switching pad modes preserves the same focused IME field and selection", async () => {
    state.keysExpanded = false;
    state.padKind = "keys";
    await act(() => { paint(); });
    const input = app.querySelector("textarea")!;
    const view = app.ownerDocument.defaultView!;
    input.value = "正在编辑的文字";
    input.focus();
    input.setSelectionRange(1, 4);
    input.dispatchEvent(new view.Event("compositionstart"));
    const tap = async (button: HTMLButtonElement) => {
      const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
      button.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      await act(() => { button.click(); });
      expect(app.querySelector("textarea")).toBe(input);
      expect(document.activeElement).toBe(input);
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
  });

  test("a latched modifier keeps its pressed chrome across output paints", async () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    await act(() => { paint(); });
    const ctrl = app.querySelector<HTMLButtonElement>(".key-mod")!;
    const view = app.ownerDocument.defaultView!;
    await act(() => {
      ctrl.dispatchEvent(new view.PointerEvent("pointerdown", {
        pointerId: 1, button: 0, bubbles: true, cancelable: true,
      }));
      ctrl.dispatchEvent(new view.PointerEvent("pointerup", {
        pointerId: 1, button: 0, bubbles: true, cancelable: true,
      }));
    });
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    expect(ctrl.classList.contains("on")).toBe(true);
    await act(() => { paint(); });
    expect(app.querySelector(".key-mod")).toBe(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    expect(ctrl.classList.contains("on")).toBe(true);
  });

  test("unmount destroys pad bindings so a detached key cannot stay pressed", async () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    await act(() => { paint(); });
    const tab = [...app.querySelectorAll("button")].find((el) => el.textContent === "Tab") as HTMLButtonElement;
    const view = app.ownerDocument.defaultView!;
    await act(() => leaveReactScreen());
    tab.dispatchEvent(new view.PointerEvent("pointerdown", { button: 0, cancelable: true }));
    expect(tab.classList.contains("is-pressed")).toBe(false);
  });
});

void happy;
