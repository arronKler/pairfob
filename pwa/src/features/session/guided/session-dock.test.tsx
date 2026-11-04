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
import type { LiveSession } from "../../../lib/protocol/client";
const { clearModifiers, modifierIsActive } = await import("../keypad/keypad");
const { flushKeys } = await import("./keys");
const { attachLiveSession } = await import("../../computers/catalog-store");
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
  attachLiveSession(null);
  selectPadPane("");
  appRoot().replaceChildren();
});

const kindOption = (label: string) =>
  [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-kind-option")].find((el) => el.textContent === label)!;

describe("React session dock", () => {
  test("collapsed pad takes no layout row: only the field and its keys button", async () => {
    setKeysExpanded(false);
    await act(() => { paint(); });
    expect(appRoot().querySelector(".pad-panel")).toBeNull();
    expect(appRoot().querySelector('[aria-label="终端快捷键"]')).toBeNull();
    expect(appRoot().querySelector(".dock-form textarea")).toBeTruthy();
    expect(appRoot().querySelector(".dock-keys-btn")).toBeTruthy();
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
    expect(appRoot().querySelector(".pad-panel .keys")?.textContent).not.toContain("Tab");
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
    await tap(appRoot().querySelector(".dock-keys-btn")!);
    expect(keysExpanded()).toBe(true);
    expect(appRoot().querySelector(".pad-panel")?.getAttribute("data-panel")).toBe("pages");
    await tap(kindOption("命令"));
    expect(appRoot().querySelector(".slash-pad")).toBeTruthy();
    await tap(kindOption("按键"));
    expect(appRoot().querySelector(".key-mod")).toBeTruthy();
    await tap(appRoot().querySelector(".key-more")!);
    expect(appRoot().querySelector(".pad-panel")?.getAttribute("data-panel")).toBe("rail");
    expect(keysExpanded()).toBe(true);
    await tap(appRoot().querySelector(".pad-panel-handle")!);
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

  test("a chord modifier survives the field tap and the next typed key sends it", async () => {
    seedPadSnapshot({ panes: [{ pane_id: "chord-test", agent: "claude" }] });
    selectPadPane("chord-test");
    const sent: string[][] = [];
    attachLiveSession({
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => { sent.push(keys); },
      sendText: async () => undefined,
    } as unknown as LiveSession);
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paint(); });
    const input = appRoot().querySelector("textarea")!;
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
    expect(modifierIsActive("ctrl")).toBe(true);
    // The field tap folds the panel for the soft keyboard, but keeps the arm.
    await act(() => {
      input.dispatchEvent(new view.PointerEvent("pointerdown", {
        pointerId: 2, pointerType: "touch", isPrimary: true, button: 0,
        clientX: 10, clientY: 0, bubbles: true, cancelable: true,
      }));
      input.focus();
    });
    expect(appRoot().querySelector(".pad-panel")).toBeNull();
    expect(keysExpanded()).toBe(false);
    expect(modifierIsActive("ctrl")).toBe(true);
    expect(appRoot().querySelector(".dock-latch")?.textContent).toContain("Ctrl");

    const typed = new view.InputEvent("beforeinput", {
      inputType: "insertText", data: "s", bubbles: true, cancelable: true,
    });
    act(() => { input.dispatchEvent(typed); });
    expect(typed.defaultPrevented).toBe(true);
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["ctrl+s"]]);
    expect(input.value).toBe("");
    expect(composeDraft()).toBe("");
    expect(appRoot().querySelector(".dock-latch")).toBeNull();
    expect(modifierIsActive("ctrl")).toBe(false);
  });

  test("the dock latch clears the arm without opening the panel", async () => {
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
    const input = appRoot().querySelector("textarea")!;
    await act(() => {
      input.dispatchEvent(new view.PointerEvent("pointerdown", {
        pointerId: 2, pointerType: "touch", isPrimary: true, button: 0,
        clientX: 10, clientY: 0, bubbles: true, cancelable: true,
      }));
      input.focus();
    });
    const latch = appRoot().querySelector<HTMLButtonElement>(".dock-latch")!;
    expect(latch).toBeTruthy();
    act(() => { latch.click(); });
    expect(modifierIsActive("ctrl")).toBe(false);
    expect(appRoot().querySelector(".dock-latch")).toBeNull();
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