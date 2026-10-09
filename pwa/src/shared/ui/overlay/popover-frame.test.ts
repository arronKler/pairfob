import { expectSameNode } from "../../../../test-support/node-identity";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { controlAt, focusPlace } from "./popover-frame";

/**
 * Focus across a redraw of the dialog. The sheet writes its close control in
 * the head and the desk card writes it after the body, so a place is the
 * control's turn in its own part, not in the whole dialog.
 */
function dialogWith(closeFirst: boolean): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  const close = '<button class="close">Close</button>';
  dialog.innerHTML = `<form>${closeFirst ? `<div class="sheet-head"><button class="back">Back</button>${close}</div>` : '<div class="sheet-head"><button class="back">Back</button></div>'}
    <div class="sheet-body"><button>Pin</button><button disabled>Unavailable</button><button>Rename</button><input aria-label="Name"></div>
    ${closeFirst ? "" : close}</form>`;
  document.body.replaceChildren(dialog);
  return dialog;
}
const named = (dialog: HTMLElement, text: string) => [...dialog.querySelectorAll("button")].find(button => button.textContent === text)!;

beforeEach(async () => { await resetBoardTestDOM(); });
// These tests replace the document's body: hand the next file the page it expects.
afterEach(async () => { await resetBoardTestDOM(); });

test("a command keeps its place when the close control moves from the head to the corner", () => {
  const sheet = dialogWith(true);
  named(sheet, "Rename").focus();
  const place = focusPlace(sheet)!;
  // The disabled row is no stop in either form; Back and Close are not counted with the commands.
  expect(place).toEqual({ body: true, at: 1 });
  sheet.querySelector("input")!.focus();
  const field = focusPlace(sheet)!;
  const card = dialogWith(false);
  expectSameNode(controlAt(card, place), named(card, "Rename"));
  expectSameNode(controlAt(card, field), card.querySelector("input"));
});

test("the close control is found as the close control, wherever it is written", () => {
  const sheet = dialogWith(true);
  named(sheet, "Close").focus();
  const place = focusPlace(sheet)!;
  expect(place).toEqual({ body: false, at: 1 });
  const card = dialogWith(false);
  expectSameNode(controlAt(card, place), named(card, "Close"));
});

test("focus outside the dialog is no place in it, and a place the redraw dropped is nothing to focus", () => {
  const sheet = dialogWith(true);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  expect(focusPlace(sheet)).toBeNull();
  expect(controlAt(sheet, { body: true, at: 9 })).toBeNull();
});
