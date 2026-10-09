import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { compile } from "sass";
import { fileURLToPath } from "node:url";
import { setLang } from "../../../lib/i18n";
import { MenuItem, showActionSheet } from "./action-sheet";
import { askConfirm, askText } from "./basic-dialogs";
import { MenuRow } from "./menu-controls";
import { bindOverlayOrigin } from "./origin";
import { useSheetNav } from "./sheet-stack";

/**
 * Every dialog focuses a control as it opens. Opened by a finger or a pen,
 * that focus draws no keyboard ring until a key is pressed; opened by a mouse
 * or a key it rings from the start. The dialog lifecycle decides, so a sheet,
 * a confirmation and a text editor behave alike.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const dialog = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1)!;
const quiet = () => dialog().hasAttribute("data-quiet-focus");
let release = () => {};

function press(target: Element, pointerType: string): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, pointerType, button: 0 }) as unknown as Event);
}
function key(name: string, target: Element = document.body): void {
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event); });
}
async function close(): Promise<void> {
  await act(async () => { closeTestDialogs(); await pause(); });
}
const OPENERS: Array<[string, () => void]> = [
  ["a sheet", () => showActionSheet("Session", modal => <MenuItem modal={modal}>Pin</MenuItem>, { popover: "menu" })],
  ["a confirmation", () => { void askConfirm({ title: "Close", message: "Close it?", confirmLabel: "Close" }); }],
  ["a text editor", () => { void askText({ title: "Rename", initial: "old" }); }],
];

beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); release = bindOverlayOrigin(document); });
afterEach(async () => { await close(); release(); });

test("a dialog a finger or a pen opened holds its ring back until the first key", async () => {
  for (const pointerType of ["touch", "pen"]) {
    for (const [name, open] of OPENERS) {
      press(document.body, pointerType);
      act(open);
      expect([name, pointerType, quiet()]).toEqual([name, pointerType, true]);
      // A press inside the open dialog is not a key, whatever it is made with.
      press(dialog(), "mouse");
      expect(quiet()).toBe(true);
      // The key is heard wherever focus is, before the dialog's own handlers.
      key("Tab", dialog());
      expect([name, pointerType, quiet()]).toEqual([name, pointerType, false]);
      await close();
    }
  }
});

test("a dialog a mouse or a key opened rings from the start", async () => {
  for (const [name, open] of OPENERS) {
    press(document.body, "mouse");
    act(open);
    expect([name, "mouse", quiet()]).toEqual([name, "mouse", false]);
    await close();
    // A finger put focus somewhere and a key then asked: the keyboard is in use.
    press(document.body, "touch");
    key("Enter");
    act(open);
    expect([name, "key", quiet()]).toEqual([name, "key", false]);
    await close();
  }
});

test("a page that remembers no gesture leaves the ring alone", async () => {
  release();
  act(OPENERS[0][1]);
  expect(quiet()).toBe(false);
});

test("the mark stays with the dialog across a pushed page, and a second dialog reads its own opening", async () => {
  function Rename() {
    const nav = useSheetNav()!;
    return <MenuRow label="Rename" next onClick={() => nav.push({ key: "rename", title: "Rename", render: () => <input aria-label="Name" /> })} />;
  }
  press(document.body, "touch");
  act(() => showActionSheet("Panel", () => <Rename />));
  const first = dialog();
  act(() => first.querySelector<HTMLButtonElement>(".menu-row")!.click());
  expect(first.querySelector("input")).not.toBeNull();
  expect(first.hasAttribute("data-quiet-focus")).toBe(true);
  // The follow-up was asked for with a key; the sheet under it was not.
  key("Enter", first);
  expect(first.hasAttribute("data-quiet-focus")).toBe(false);
  act(() => { void askConfirm({ title: "Close", message: "Close it?", confirmLabel: "Close" }); });
  expect(dialog().className).toContain("confirm");
  expect(quiet()).toBe(false);
});

test("one rule draws it: no ring inside a marked dialog, however specific a control's own ring is", () => {
  const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]*data-quiet-focus[^{}]*)\{([^{}]*)\}/g)];
  expect(rules.map(match => match[1].trim())).toEqual(["dialog[data-quiet-focus] :focus-visible"]);
  expect(rules[0][2]).toMatch(/outline:\s*none\s*!important/);
});
