import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { applySnapshot } from "../../dashboard/catalog-store";
import { selectPane } from "../session-store";
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { FullTerminalPad } from "../full-terminal/full-terminal-pad";
import { PadPages } from "./pad-pages";
import { EXPANDED_KEYS, clearModifiers, modifierIsActive } from "./keypad";
import { keysExpanded } from "../../settings/preferences-store";
import { setComposeDraft, composeDraft, setComposeLive } from "../compose-store";
import { focusRestoringCompose } from "../compose-focus";


beforeEach(async () => {
  await resetBoardTestDOM();
  applySnapshot({ panes: [{ pane_id: "shortcut-test", agent: "claude" }] });
  selectPane("shortcut-test");
  setKeysExpanded(true); setPadKind("keys"); setComposeLive(false);
});
afterEach(() => {
  delete document.documentElement.dataset.kb;
  unmountReact(); clearModifiers(); setKeysExpanded(false); setPadKind("keys"); setComposeDraft(""); setComposeLive(false);
});
function paint() {
  const sent: string[] = [];
  renderReact(createElement(FullTerminalPad, { options: {
    sendKey: key => { sent.push(key); }, sendCompose: () => true, hardwareKeyboard: false,
    keyboard: { open() {}, close() {}, toggle() {}, isOpen: () => false },
  } }));
  return sent;
}
function pointer(target: Element, type: string, x: number, y = 0) {
  const view = appRoot().ownerDocument.defaultView!;
  act(() => { target.dispatchEvent(new view.PointerEvent(type, {
    pointerType: "touch", pointerId: 1, isPrimary: true, button: 0,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  })); });
}
function kind(label: "按键" | "命令") {
  return [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-kind-option")].find(el => el.textContent === label)!;
}
function button(label: string) {
  return [...appRoot().querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label || el.getAttribute("aria-label") === label)!;
}

test("swiping from a sending key changes page without sending; reverse swipe and a tap still work", () => {
  const sent = paint();
  const tab = button("Tab");
  pointer(tab, "pointerdown", 100);
  expect(sent).toEqual([]);
  pointer(tab, "pointermove", 40);
  pointer(tab, "pointerup", 40);
  expect(sent).toEqual([]);
  expect(button("Ctrl+A")).toBeTruthy();
  const nextKey = button("Ctrl+A");
  pointer(nextKey, "pointerdown", 40);
  pointer(nextKey, "pointermove", 100);
  pointer(nextKey, "pointerup", 100);
  expect(modifierIsActive("shift")).toBe(false);
  expect(button("Tab")).toBeTruthy();
  pointer(button("Tab"), "pointerdown", 0);
  pointer(button("Tab"), "pointerup", 0);
  expect(sent).toEqual(["tab"]);
});

test("cancelled or vertical gestures never send a key or navigate", () => {
  const sent = paint();
  const tab = button("Tab");
  pointer(tab, "pointerdown", 0);
  pointer(tab, "pointercancel", 0);
  pointer(tab, "pointerdown", 0);
  pointer(tab, "pointermove", 0, 80);
  pointer(tab, "pointerup", 0, 80);
  expect(sent).toEqual([]);
  expect(button("Tab")).toBeTruthy();
});

test("page dots and mode toggle retain each mode's position and the compose field", () => {
  paint();
  const input = appRoot().querySelector("textarea")!;
  act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="第 2 页，共 2 页"]')!.click(); });
  expect(button("Ctrl+A")).toBeTruthy();
  expect(appRoot().querySelector(".pad-page-name")?.textContent).toBe("选择与编辑");
  act(() => { kind("命令").click(); });
  expect(button("/clear")).toBeTruthy();
  expect(kind("命令").getAttribute("aria-pressed")).toBe("true");
  act(() => { kind("按键").click(); });
  expect(button("Ctrl+A")).toBeTruthy();
  expectSameNode(appRoot().querySelector("textarea"), input);
  act(() => { appRoot().querySelector<HTMLButtonElement>(".key-more")!.click(); });
  expect(appRoot().querySelector<HTMLElement>(".pad-panel")?.dataset.panel).toBe("rail");
  expect(appRoot().querySelector(".pad-pages")).not.toBeNull();
  // Touching the field is the way back to typing: the panel gets out of its way.
  act(() => { input.focus(); });
  expect(appRoot().querySelector(".pad-panel")).toBeNull();
  expectSameNode(appRoot().querySelector("textarea"), input);
  expectSameNode(document.activeElement, input);
});

test("a tap on the field folds the panel even when the field already holds the caret", () => {
  paint();
  const input = appRoot().querySelector("textarea")!;
  act(() => { input.focus(); });
  // The keys button keeps the caret where it was, so reopening the panel fires
  // no focus report the panel could read as the reader coming back to type.
  act(() => { appRoot().querySelector<HTMLButtonElement>(".dock-keys-btn")!.click(); });
  expect(appRoot().querySelector(".pad-panel")).toBeTruthy();
  pointer(input, "pointerdown", 10);
  expect(appRoot().querySelector(".pad-panel")).toBeNull();
  expectSameNode(document.activeElement, input);
});

test("the app restoring focus after a repaint leaves the panel open; the reader's own focus folds it", () => {
  paint();
  const input = appRoot().querySelector("textarea")!;
  // finishSessionPaint hands the caret back on every repaint; that is not the
  // reader moving to the field.
  act(() => { focusRestoringCompose(input); });
  expect(appRoot().querySelector(".pad-panel")).toBeTruthy();
  expectSameNode(document.activeElement, input);
  act(() => { input.blur(); input.focus(); });
  expect(appRoot().querySelector(".pad-panel")).toBeNull();
});

test("swiping a command suppresses its generated click, but the next deliberate click works", () => {
  setPadKind("slash"); paint();
  const command = button("/clear");
  pointer(command, "pointerdown", 100);
  pointer(command, "pointermove", 40);
  pointer(command, "pointerup", 40);
  const view = appRoot().ownerDocument.defaultView!;
  act(() => { command.dispatchEvent(new view.MouseEvent("click", { detail: 1, bubbles: true })); });
  expect(composeDraft()).toBe("");
  act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="第 1 页，共 2 页"]')!.click(); });
  const firstCommand = button("/clear");
  pointer(firstCommand, "pointerdown", 0);
  pointer(firstCommand, "pointerup", 0);
  act(() => { firstCommand.click(); });
  expect(composeDraft()).toBe("/clear ");
});

test("additional shortcuts automatically create more pages with accessible navigation", () => {
  renderReact(createElement(PadPages, { kind: "extra", label: "Extra", items:
    Array.from({ length: 19 }, (_, n) => createElement("button", { key: n }, String(n))) }));
  expect(appRoot().querySelectorAll(".pad-page-dot")).toHaveLength(3);
  act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="第 3 页，共 3 页"]')!.click(); });
  expect(appRoot().querySelector(".pad-page")!.textContent).toBe("161718");
});

test("modifiers stay together and still form chords with the fixed arrow row", () => {
  const sent = paint();
  act(() => { button("Ctrl").click(); button("Shift").click(); button("上箭头").click(); });
  expect(sent).toEqual(["ctrl+shift+up"]);
  const ctrl = button("Ctrl");
  pointer(ctrl, "pointerdown", 100);
  pointer(ctrl, "pointermove", 40);
  pointer(ctrl, "pointerup", 40);
  expect(modifierIsActive("ctrl")).toBe(false);
});

test("a touch hold repeats, stops on movement, and does not become a page swipe", async () => {
  const sent = paint();
  act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="第 2 页，共 2 页"]')!.click(); });
  const key = button("Ctrl+A");
  pointer(key, "pointerdown", 100);
  expect(sent).toEqual([]);
  await act(async () => {
    for (let attempt = 0; attempt < 25 && sent.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  pointer(key, "pointermove", 40);
  pointer(key, "pointerup", 40);
  expect(button("Ctrl+A")).toBeTruthy();
  expect(sent.length).toBeGreaterThanOrEqual(2);
  const stopped = sent.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(sent.length).toBe(stopped);
  expect(sent.every(value => value === "ctrl+a")).toBe(true);
});

test("keys fit fourteen per page while commands keep four columns", () => {
  paint();
  expect(appRoot().querySelector(".pad-page")?.getAttribute("data-columns")).toBe("7");
  expect(appRoot().querySelectorAll(".pad-page .key")).toHaveLength(EXPANDED_KEYS.length);
  expect(EXPANDED_KEYS).toHaveLength(14);
  expect(appRoot().querySelectorAll(".pad-page-dot")).toHaveLength(2);
  expect(appRoot().querySelector(".pad-page-name")?.textContent).toBe("控制");
  // The primary row keeps seven cells: six keys and the pad toggle.
  expect(appRoot().querySelectorAll('[aria-label="终端快捷键"] > *')).toHaveLength(7);
  act(() => { kind("命令").click(); });
  expect(appRoot().querySelector(".pad-page")?.getAttribute("data-columns")).toBe("4");
  expect(appRoot().querySelectorAll(".slash-cmd")).toHaveLength(8);
});

test("the newline key is gone: Return in the field is the newline now", () => {
  paint();
  expect(button("换行")).toBeUndefined();
  expect(appRoot().querySelector('[aria-label="在输入框里插入换行"]')).toBeNull();
});

test("the soft keyboard and the panel are never shown together", async () => {
  paint();
  const root = document.documentElement;
  const input = appRoot().querySelector("textarea")!;
  // Mutation observers deliver on a microtask; the async act flushes the re-render.
  await act(async () => { input.focus(); root.dataset.kb = "open"; await Promise.resolve(); });
  // Touching the field put the panel away; the glass keyboard has the screen.
  expect(appRoot().querySelector(".pad-panel")).toBeNull();
  expect(keysExpanded()).toBe(false);

  // Asking for keys puts the keyboard away first. Until it settles closed the
  // panel stays hidden, and the button already reads as closed.
  act(() => { appRoot().querySelector<HTMLButtonElement>(".dock-keys-btn")!.click(); });
  expect(keysExpanded()).toBe(true);
  expect(appRoot().querySelector(".pad-panel")).toBeNull();
  expect(appRoot().querySelector(".dock-keys-btn")?.getAttribute("aria-expanded")).toBe("false");
  expectDifferentNode(document.activeElement, input);

  await act(async () => { root.dataset.kb = "closed"; await Promise.resolve(); });
  expect(appRoot().querySelector(".pad-panel")).toBeTruthy();
  expect(appRoot().querySelector(".dock-keys-btn")?.getAttribute("aria-expanded")).toBe("true");
});
