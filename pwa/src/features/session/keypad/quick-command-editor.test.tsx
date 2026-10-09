import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { bindOverlayOrigin } from "../../../shared/ui/overlay";
import { tabStops } from "../../../shared/ui/overlay/tab-stops";
import { editQuickCommand, type QuickCommandEdit } from "./quick-command-editor";

/** The command editor is a dialog like the others: the card for a mouse beside the list, the sheet for a finger. */
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.quick-command-sheet")!;
const settle = () => act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
let release = () => {};

function press(pointerType: string): void {
  document.body.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 800, height: 700 });
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  release();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a mouse opens the editor as the card, and it still saves", async () => {
  press("mouse");
  let edit!: Promise<QuickCommandEdit | null>;
  act(() => { edit = editQuickCommand({ command: { id: "review", label: "Review", text: "review the diff", pinned: false } }); });
  await settle();
  expect(sheet().className).toBe("modal sheet quick-command-sheet desk-form");
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  await act(async () => { sheet().querySelector<HTMLButtonElement>("button[type=submit]")!.click(); });
  expect(await edit).toEqual({ action: "save", label: "Review", text: "review the diff" });
});

test("a finger opens the same editor as the sheet", async () => {
  press("touch");
  act(() => { void editQuickCommand({}); });
  await settle();
  expect(sheet().className).toBe("modal sheet quick-command-sheet");
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
});

/** The editor's controls in the order Tab meets them, by class or tag. */
const order = () => tabStops(sheet()).map(stop => stop.className.split(" ")[0] || stop.tagName.toLowerCase());

test("the card is written as it is drawn: the title, the fields, Cancel then the action, the close", async () => {
  press("mouse");
  const command = { id: "review", label: "Review", text: "review the diff", pinned: false };
  act(() => { void editQuickCommand({ command }); });
  await settle();
  expect([...sheet().querySelector("form")!.children].map(child => child.className.split(" ")[0]))
    .toEqual(["sheet-grab", "quick-sheet-title", "quick-sheet-body", "desk-actions", "icon-btn"]);
  expect(order()).toEqual(["input", "textarea", "quick-sheet-delete", "desk-cancel", "desk-action", "icon-btn"]);
  expect(sheet().querySelector(".quick-sheet-bar")).toBeNull();
  // It starts in the name, selected, as a rename does; not on Cancel.
  const name = sheet().querySelector("input")!;
  expectSameNode(document.activeElement, name);
  expect([name.selectionStart, name.selectionEnd]).toEqual([0, "Review".length]);
  await act(async () => { closeTestDialogs(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });

  // The sheet keeps its bar above the fields, and a command opened under a finger raises no keyboard.
  press("touch");
  act(() => { void editQuickCommand({ command }); });
  await settle();
  expect(order()).toEqual(["quick-sheet-text-btn", "quick-sheet-text-btn", "input", "textarea", "quick-sheet-delete"]);
  expect(sheet().querySelector(".desk-actions, .desk-close")).toBeNull();
  expectDifferentNode(document.activeElement, sheet().querySelector("input"));
  await act(async () => { closeTestDialogs(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  // A new command starts in its name under either.
  act(() => { void editQuickCommand({}); });
  await settle();
  expectSameNode(document.activeElement, sheet().querySelector("input"));
});

/** A pad button, which never takes focus from the compose field when pressed. */
function padButton(): { button: HTMLButtonElement; field: HTMLTextAreaElement; remove(): void } {
  const field = document.createElement("textarea");
  const button = document.createElement("button");
  button.textContent = "New command";
  document.body.append(field, button);
  field.focus();
  return { button, field, remove() { field.remove(); button.remove(); } };
}

test("Escape and the card's own close hand focus back to the pad button that opened it", async () => {
  const pad = padButton();
  for (const leave of ["escape", "close", "cancel"] as const) {
    pad.field.focus();
    pad.button.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
    expectSameNode(document.activeElement, pad.field);
    act(() => { void editQuickCommand({}); });
    await settle();
    expect(sheet().className).toContain("desk-form");
    await act(async () => {
      if (leave === "escape") sheet().dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
      else sheet().querySelector<HTMLButtonElement>(leave === "close" ? ".desk-close" : ".desk-cancel")!.click();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    expect(document.querySelector("dialog.quick-command-sheet")).toBeNull();
    expectSameNode(document.activeElement, pad.button);
  }
  pad.remove();
});

test("the keyboard's opener gets focus back too; a finger's goes back to where it was", async () => {
  const pad = padButton();
  pad.button.focus();
  pad.button.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  pad.field.focus();
  act(() => { void editQuickCommand({}); });
  await settle();
  await act(async () => { closeTestDialogs(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  expectSameNode(document.activeElement, pad.button);

  pad.field.focus();
  pad.button.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
  act(() => { void editQuickCommand({}); });
  await settle();
  expect(sheet().querySelector(".desk-close")).toBeNull();
  await act(async () => { closeTestDialogs(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  expectSameNode(document.activeElement, pad.field);
  pad.remove();
});

test("⌘ or Ctrl with Enter in the command's text submits; a bare Enter stays a new line", async () => {
  press("mouse");
  let edit!: Promise<QuickCommandEdit | null>;
  act(() => { edit = editQuickCommand({ command: { id: "review", label: "Review", text: "review the diff", pinned: false } }); });
  await settle();
  const text = sheet().querySelector("textarea")!;
  const bare = new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  act(() => { text.dispatchEvent(bare); });
  expect(bare.defaultPrevented).toBeFalse();
  expect(sheet().open).toBeTrue();
  await act(async () => {
    text.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(await edit).toEqual({ action: "save", label: "Review", text: "review the diff" });
});
