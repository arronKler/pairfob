import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { composeDraft, composeFocused, composeIME, setComposeDraft, setComposeFocused, setComposeIME } from "../compose-store";
import { keysExpanded, padKind, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
const { clearModifiers } = await import("../keypad/keypad");
const { SLASH_COMMANDS } = await import("../../../lib/slash-commands");
const { SessionDock } = await import("./session-dock");

function paint() {
  renderReact(createElement(SessionDock, { includeBack: true }));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
});

afterEach(async () => {
  unmountReact();
  clearModifiers();
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeIME(false);
  setComposeFocused(false);
  setComposeDraft("");
  appRoot().replaceChildren();
});

describe("React session dock", () => {
  test("collapsed pad keeps only the TUI survival row", async () => {
    setKeysExpanded(false);
    await act(() => { paint(); });
    expect(appRoot().querySelector(".pad-mode")).toBeNull();
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
    expect(appRoot().querySelector(".dock-form textarea")).toBeTruthy();
  });

  test("expanded keys still expose Tab, Enter and modifiers", async () => {
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paint(); });
    expect(appRoot().querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().textContent).toContain("Tab");
    expect(appRoot().textContent).toContain("Ctrl");
    expect(appRoot().textContent).toContain("换行");
  });

  test("expanded command morph fills compose chips and not SendKeys", async () => {
    setKeysExpanded(true);
    setPadKind("slash");
    await act(() => { paint(); });
    const chips = [...appRoot().querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(appRoot().querySelector(".keys-wrap")?.textContent).not.toContain("Tab");
    expect(appRoot().querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
  });

  test("expanding and switching pad modes preserves the same focused IME field and selection", async () => {
    setKeysExpanded(false);
    setPadKind("keys");
    await act(() => { paint(); });
    const input = appRoot().querySelector("textarea")!;
    const view = appRoot().ownerDocument.defaultView!;
    input.value = "正在编辑的文字";
    act(() => { input.focus(); });
    input.setSelectionRange(1, 4);
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    const tap = async (button: HTMLButtonElement) => {
      const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
      act(() => { button.dispatchEvent(down); });
      expect(down.defaultPrevented).toBe(true);
      await act(() => { button.click(); });
      expect(appRoot().querySelector("textarea")).toBe(input);
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
      expect(input.value).toBe("正在编辑的文字");
      expect(composeIME()).toBe(true);
    };
    await tap(appRoot().querySelector(".key-more")!);
    expect(keysExpanded()).toBe(true);
    await tap(appRoot().querySelectorAll<HTMLButtonElement>(".pad-mode button")[1]!);
    expect(appRoot().querySelector(".slash-pad")).toBeTruthy();
    await tap(appRoot().querySelectorAll<HTMLButtonElement>(".pad-mode button")[0]!);
    expect(appRoot().querySelector(".key-mod")).toBeTruthy();
    await tap(appRoot().querySelector(".key-more")!);
    expect(keysExpanded()).toBe(false);
  });

  test("a latched modifier keeps its pressed chrome across output paints", async () => {
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paint(); });
    const ctrl = appRoot().querySelector<HTMLButtonElement>(".key-mod")!;
    const view = appRoot().ownerDocument.defaultView!;
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
    expect(appRoot().querySelector(".key-mod")).toBe(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    expect(ctrl.classList.contains("on")).toBe(true);
  });

  test("unmount destroys pad bindings so a detached key cannot stay pressed", async () => {
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paint(); });
    const tab = [...appRoot().querySelectorAll("button")].find((el) => el.textContent === "Tab") as HTMLButtonElement;
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => { unmountReact(); });
    tab.dispatchEvent(new view.PointerEvent("pointerdown", { button: 0, cancelable: true }));
    expect(tab.classList.contains("is-pressed")).toBe(false);
  });
});