import { expectSameNode } from "../../../../test-support/node-identity";
import { applySnapshot as seedPadSnapshot } from "../../dashboard/catalog-store";
import { selectPane as selectPadPane } from "../session-store";
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

const kindOption = (label: string) =>
  [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-kind-option")].find((el) => el.textContent === label)!;

describe("React session dock", () => {
  test("collapsed pad keeps only the TUI survival row", async () => {
    setKeysExpanded(false);
    await act(() => { paint(); });
    expect(appRoot().querySelector(".pad-kind")).toBeNull();
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
    expect(appRoot().querySelector(".dock-form textarea")).toBeTruthy();
  });

  test("expanded keys still expose Tab, Enter and modifiers", async () => {
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paint(); });
    expect(kindOption("按键").getAttribute("aria-pressed")).toBe("true");
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().textContent).toContain("Tab");
    expect(appRoot().textContent).toContain("Ctrl");
    expect(appRoot().textContent).not.toContain("换行");
  });

  test("expanded command morph fills compose chips and not SendKeys", async () => {
    seedPadSnapshot({ panes: [{ pane_id: "shortcut-test", agent: "claude" }] });
    selectPadPane("shortcut-test");
    setKeysExpanded(true);
    setPadKind("slash");
    await act(() => { paint(); });
    const chips = [...appRoot().querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(appRoot().querySelector(".keys-wrap")?.textContent).not.toContain("Tab");
    expect(kindOption("命令").getAttribute("aria-pressed")).toBe("true");
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
      expectSameNode(appRoot().querySelector("textarea"), input);
      expectSameNode(document.activeElement, input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
      expect(input.value).toBe("正在编辑的文字");
      expect(composeIME()).toBe(true);
    };
    await tap(appRoot().querySelector(".key-more")!);
    expect(keysExpanded()).toBe(true);
    await tap(kindOption("命令"));
    expect(appRoot().querySelector(".slash-pad")).toBeTruthy();
    await tap(kindOption("按键"));
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
    expectSameNode(appRoot().querySelector(".key-mod"), ctrl);
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