import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { applySnapshot as seedPadSnapshot } from "../../dashboard/catalog-store";
import { selectPane as selectPadPane } from "../session-store";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { appRoot } from "../../../app/dom-root";

const { setLang } = await import("../../../lib/i18n");
const { clearNotice, visibleNotice } = await import("../../../app/notices-store");
const { clearModifiers, pressModifier, withModifiers } = await import("../keypad/keypad.ts");
const { selectPadKind } = await import("./slash-pad.ts");
const { keysExpanded, padKind, preferencesStore, resetPreferences, setKeysExpanded, setPadKind, setQuickCommands } =
  await import("../../settings/preferences-store.ts");
const { composeDraft, setComposeDraft, setComposeLive } = await import("../compose-store");
const { SessionKeyPad } = await import("./session-keypad.tsx");
const { SessionSlashPad } = await import("./session-slash-pad.tsx");
const pad = await Bun.file(new URL("./slash-pad.ts", import.meta.url)).text();
const slashView = await Bun.file(new URL("./session-slash-pad.tsx", import.meta.url)).text();

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  clearNotice();
  seedPadSnapshot({ panes: [{ pane_id: "shortcut-test", agent: "claude" }] });
  selectPadPane("shortcut-test");
});

afterEach(async () => {
  closeTestDialogs();
  unmountReact();
  clearModifiers();
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeDraft("");
  setComposeLive(false);
  resetPreferences();
  localStorage.removeItem("pairfob:quickCommands");
  clearNotice();
  appRoot().replaceChildren();
});

const own = (id: string, pinned: boolean) => ({ id, label: id.toUpperCase(), text: `${id} text`, pinned });
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find(el => el.textContent === text)!;
/** Controlled fields: set through the element's prototype, focused, then input + keyup (see create-sheet.test). */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = field.ownerDocument.defaultView!;
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new view.Event("input", { bubbles: true }));
    field.dispatchEvent(new view.KeyboardEvent("keyup", { bubbles: true }));
  });
}
const savedIds = () => preferencesStore.get().quickCommands?.map(item => `${item.id}:${item.pinned}`);

describe("expanded pad modes", () => {
  test("the kind switch lives in the pagination row once the pad is expanded", async () => {
    setKeysExpanded(false);
    renderReact(createElement(SessionKeyPad));
    expect(appRoot().querySelector(".pad-kind")).toBeNull();
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    act(() => { setKeysExpanded(true); });
    expect(appRoot().querySelector(".pad-pagination .pad-kind")).toBeTruthy();
    expect(appRoot().querySelector(".keys .pad-kind")).toBeNull();
    expect(keysExpanded()).toBe(true);
  });

  test("slash chips go to the start of the draft through the compose contract, never as keys", async () => {
    const tokens: string[] = [];
    renderReact(createElement(SessionSlashPad, { onSelect: (text: string) => tokens.push(text) }));
    act(() => { appRoot().querySelector<HTMLButtonElement>(".slash-cmd")!.click(); });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.startsWith("/")).toBeTrue();
    expect(slashView).toContain("onSelect = insertSlashCommand");
    expect(slashView).toContain("onCustomSelect = insertQuickCommand");
    expect(slashView).not.toContain("queueKey");
    expect(slashView).not.toContain("sendPad");
  });

  test("switching kinds morphs the expanded body and drops latched modifiers", () => {
    setPadKind("keys");
    pressModifier("ctrl");
    let painted = 0;
    selectPadKind("slash", () => { painted++; });
    expect(padKind()).toBe("slash");
    expect(painted).toBe(1);
    expect(withModifiers("c")).toEqual(["c"]);
    expect(pad).toContain("clearModifiers()");
    expect(pad).toContain("setPadKind(kind)");
  });

  test("the switch drawn by a turn of the pad knows which side its thumb comes from; any other paint of it is still", () => {
    // Render time on a loaded test host is not elapsed gesture time.
    const now = spyOn(performance, "now").mockReturnValue(1000);
    try {
      const option = (label: string) => byText(".pad-kind-option", label) as HTMLButtonElement;
      const from = () => appRoot().querySelector<HTMLElement>(".pad-kind")!.getAttribute("data-from");
      setKeysExpanded(true);
      renderReact(createElement(SessionKeyPad));
      // The pad opened: nothing was turned.
      expect(from()).toBeNull();
      const opened = appRoot().querySelector(".pad-kind");
      act(() => { option("命令").click(); });
      // Turning the pad draws a new switch with the new body.
      expectDifferentNode(appRoot().querySelector(".pad-kind"), opened);
      expect(from()).toBe("first");
      expect(option("命令").getAttribute("aria-pressed")).toBe("true");
      // The same switch painted again keeps its mark and its node: nothing replays.
      const turned = appRoot().querySelector(".pad-kind");
      renderReact(createElement(SessionKeyPad));
      expectSameNode(appRoot().querySelector(".pad-kind"), turned);
      act(() => { option("按键").click(); });
      expect(from()).toBe("last");
    } finally { now.mockRestore(); }
  });

  test("a switch drawn after the turn is over stands still", () => {
    const now = spyOn(performance, "now").mockReturnValue(1000);
    try {
      setKeysExpanded(true);
      renderReact(createElement(SessionKeyPad));
      act(() => { (byText(".pad-kind-option", "命令") as HTMLButtonElement).click(); });
      now.mockReturnValue(1200);
      // Put away and brought back: the pad is in commands, and nobody just turned it.
      act(() => { setKeysExpanded(false); });
      act(() => { setKeysExpanded(true); });
      expect(appRoot().querySelector<HTMLElement>(".pad-kind")!.hasAttribute("data-from")).toBeFalse();
    } finally { now.mockRestore(); }
  });

  test("a saved command goes in at the caret and does not send", async () => {
    setQuickCommands([own("review", true)]);
    setComposeDraft("");
    renderReact(createElement(SessionSlashPad, {}));
    await act(async () => { appRoot().querySelector<HTMLButtonElement>(".quick-cmd")!.click(); });
    expect(composeDraft()).toBe("review text");
  });

  test("pinned commands come before slash commands, the rest after", () => {
    setQuickCommands([own("a", false), own("b", true)]);
    renderReact(createElement(SessionSlashPad, {}));
    const first = appRoot().querySelector(".pad-page")!.children;
    expect(first[0]!.textContent).toBe("B");
    expect(first[1]!.classList.contains("slash-cmd")).toBeTrue();
  });
});

describe("editing commands in place", () => {
  test("Edit wobbles your commands, locks slash commands and swaps the pagination row", () => {
    setQuickCommands([own("a", true), own("b", false)]);
    renderReact(createElement(SessionSlashPad, {}));
    expect(appRoot().querySelector(".pad-edit-hint")).toBeNull();
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    expect(appRoot().querySelector(".pad-edit-hint")?.textContent).toBe("拖动你的指令调整位置；排在斜杠命令之前的会出现在第一页");
    expect(appRoot().querySelectorAll(".quick-cmd.is-editing").length).toBeGreaterThan(0);
    expect(appRoot().querySelector('[aria-label="删除 A"]')).toBeTruthy();
    const locked = appRoot().querySelector(".slash-cmd.is-locked")!;
    expect(locked.tagName).toBe("SPAN");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(appRoot().querySelector(".pad-kind")).toBeNull();
    expect(appRoot().querySelector(".pad-pagination-start")?.textContent).toBe("新建");
    expect(appRoot().querySelector(".pad-pagination-end")?.textContent).toBe("完成");
    act(() => { byText(".pad-text-btn", "完成").click(); });
    expect(appRoot().querySelector(".quick-cmd.is-editing")).toBeNull();
  });

  test("× deletes at once and the hint line offers undo", () => {
    setQuickCommands([own("a", true), own("b", false)]);
    renderReact(createElement(SessionSlashPad, {}));
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="删除 A"]')!.click(); });
    expect(savedIds()).toEqual(["b:false"]);
    expect(appRoot().querySelector(".pad-edit-hint")?.textContent).toBe("已删除「A」撤销");
    act(() => { appRoot().querySelector<HTMLButtonElement>(".pad-undo")!.click(); });
    expect(savedIds()).toEqual(["a:true", "b:false"]);
  });

  test("tapping a command opens the half-height editor; Done saves in place", async () => {
    setQuickCommands([own("a", true)]);
    renderReact(createElement(SessionSlashPad, {}));
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="编辑指令：A"]')!.click(); });
    const sheet = document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
    expect(sheet.querySelector(".modal-title")?.textContent).toBe("编辑指令");
    expect(sheet.textContent).toContain("插入到输入框的光标处，不会直接发送。");
    expect(sheet.textContent).toContain("删除这条指令");
    expect(sheet.querySelector(".quick-sheet-draft")).toBeNull();
    type(sheet.querySelector("input")!, "Renamed");
    expect(sheet.textContent).toContain("7/24");
    await act(async () => { sheet.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    expect(preferencesStore.get().quickCommands?.[0]).toEqual({ id: "a", label: "Renamed", text: "a text", pinned: true });
  });

  test("with no commands of your own the first cell offers to add one, from the draft if there is one", async () => {
    setQuickCommands([]);
    setComposeDraft("先读一遍 README 再动手\n第二行");
    renderReact(createElement(SessionSlashPad, {}));
    const add = appRoot().querySelector<HTMLButtonElement>(".pad-page > .quick-add-first")!;
    expect(add.textContent).toBe("添加常用指令");
    act(() => { add.click(); });
    const sheet = document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
    expect(sheet.querySelector(".modal-title")?.textContent).toBe("新建指令");
    expect(sheet.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBeTrue();
    act(() => { sheet.querySelector<HTMLButtonElement>(".quick-sheet-draft")!.click(); });
    expect(sheet.querySelector("input")!.value).toBe("先读一遍 REA");
    expect(sheet.querySelector("textarea")!.value).toBe("先读一遍 README 再动手\n第二行");
    await act(async () => { sheet.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    expect(preferencesStore.get().quickCommands?.map(item => [item.label, item.pinned])).toEqual([["先读一遍 REA", true]]);
  });

  test("a new command lands at the end when page 1 already holds eight", async () => {
    setQuickCommands(Array.from({ length: 8 }, (_, n) => own(`p${n}`, true)));
    renderReact(createElement(SessionSlashPad, {}));
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="新建指令"]')!.click(); });
    const sheet = document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
    type(sheet.querySelector("input")!, "Last");
    type(sheet.querySelector("textarea")!, "last text");
    await act(async () => { sheet.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    expect(preferencesStore.get().quickCommands?.at(-1)).toMatchObject({ label: "Last", pinned: false });
    expect(visibleNotice()?.text).toBe("第一页已满，已添加到最后");
  });

  test("an empty list offers the three stock examples, one tap each", () => {
    setQuickCommands([]);
    renderReact(createElement(SessionSlashPad, {}));
    const examples = [...appRoot().querySelectorAll<HTMLButtonElement>(".quick-example")];
    expect(examples.map(el => el.textContent)).toEqual(["检查改动", "运行测试", "总结进度"]);
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="添加示例指令：运行测试"]')!.click(); });
    expect(preferencesStore.get().quickCommands?.map(item => [item.id, item.pinned])).toEqual([["test", true]]);
    expect(appRoot().querySelector(".quick-example")).toBeNull();
  });

  test("the edit sheet moves a command one slot for keyboard users, pinning across the slash commands", () => {
    setQuickCommands([own("a", true), own("b", false)]);
    renderReact(createElement(SessionSlashPad, {}));
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>(".pad-page-dot:last-child")!.click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="编辑指令：B"]')!.click(); });
    const sheet = document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
    const earlier = sheet.querySelector<HTMLButtonElement>('[aria-label="把这条指令前移一格"]')!;
    const later = sheet.querySelector<HTMLButtonElement>('[aria-label="把这条指令后移一格"]')!;
    expect(later.disabled).toBeTrue();
    act(() => { earlier.click(); });
    expect(savedIds()).toEqual(["a:true", "b:true"]);
    expect(sheet.querySelector('.quick-sheet-reorder [role="status"]')?.textContent).toBe("已移到斜杠命令之前，会出现在第一页");
    act(() => { earlier.click(); });
    expect(savedIds()).toEqual(["b:true", "a:true"]);
    expect(earlier.disabled).toBeTrue();
  });

  test("a keyboard step refuses a ninth pin", () => {
    setQuickCommands([...Array.from({ length: 8 }, (_, n) => own(`p${n}`, true)), own("x", false)]);
    renderReact(createElement(SessionSlashPad, {}));
    act(() => { byText(".pad-text-btn", "编辑").click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>(".pad-page-dot:last-child")!.click(); });
    act(() => { appRoot().querySelector<HTMLButtonElement>('[aria-label="编辑指令：X"]')!.click(); });
    const sheet = document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
    act(() => { sheet.querySelector<HTMLButtonElement>('[aria-label="把这条指令前移一格"]')!.click(); });
    expect(sheet.querySelector('.quick-sheet-reorder [role="status"]')?.textContent).toBe("第一页最多放 8 条你的指令");
    expect(savedIds()?.at(-1)).toBe("x:false");
  });
});
