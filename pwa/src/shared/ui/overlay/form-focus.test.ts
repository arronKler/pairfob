import { expectSameNode } from "../../../../test-support/node-identity";
import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { focusRefused, holdFocus } from "./form-focus";

/**
 * Where a form leaves the keyboard: in the field a refusal is about, and on a
 * control that stays usable while the form is locked, back to where the reader
 * was once it is unlocked.
 */
const by = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(async () => {
  await resetTestDOM();
  document.body.insertAdjacentHTML("beforeend", `<div id="fixture">
    <div id="form">
      <fieldset id="fields">
        <input id="branch" name="branch">
        <input id="hidden" type="hidden" name="kind" value="x">
        <div id="dirs" data-field="dir">
          <p>recent</p>
          <button id="dir-a" aria-pressed="false">/a</button>
          <button id="dir-b" aria-pressed="true">/b</button>
        </div>
        <input id="target" name="target">
      </fieldset>
    </div>
    <button id="primary">Create</button>
    <button id="elsewhere">Other</button>
  </div>`);
});
afterEach(() => by("fixture").remove());

test("a refusal puts the reader in the field it names", () => {
  by("primary").focus();
  expectSameNode(focusRefused(by("form"), "target"), by("target"));
  expectSameNode(document.activeElement, by("target"));
});

test("a set of choices is entered at the chosen one, else its first", () => {
  expectSameNode(focusRefused(by("form"), "dir"), by("dir-b"));
  by("dir-b").setAttribute("aria-pressed", "false");
  expectSameNode(focusRefused(by("form"), "dir"), by("dir-a"));
});

test("without a name it is the field already marked invalid, else the first field; a hidden one is never it", () => {
  expectSameNode(focusRefused(by("form")), by("branch"));
  by("target").setAttribute("aria-invalid", "true");
  expectSameNode(focusRefused(by("form")), by("target"));
  expect(focusRefused(by("form"), "kind")).not.toBe(by("hidden"));
  expect(focusRefused(null, "target")).toBeNull();
});

test("a locked form hands focus to the control that stays, and takes it back when it is unlocked", () => {
  const focus = holdFocus();
  by("branch").focus();
  focus.note(by("form"));
  (by("fields") as HTMLFieldSetElement).disabled = true;
  // A browser has dropped the disabled field's focus by now.
  by("branch").blur();
  focus.lock(by("primary"));
  expectSameNode(document.activeElement, by("primary"));
  (by("fields") as HTMLFieldSetElement).disabled = false;
  focus.settle(by("primary"));
  expectSameNode(document.activeElement, by("branch"));
});

test("the press on the button itself moves nothing, and focus the reader took elsewhere is left alone", () => {
  const focus = holdFocus();
  by("primary").focus();
  focus.note(by("form"));
  focus.lock(by("primary"));
  focus.settle(by("primary"));
  expectSameNode(document.activeElement, by("primary"));

  by("branch").focus();
  focus.note(by("form"));
  focus.lock(by("primary"));
  by("elsewhere").focus();
  focus.settle(by("primary"));
  expectSameNode(document.activeElement, by("elsewhere"));
});

test("a refusal that already put the reader in a field wins over where they were", () => {
  const focus = holdFocus();
  by("branch").focus();
  focus.note(by("form"));
  focus.lock(by("primary"));
  focusRefused(by("form"), "target");
  focus.settle(by("primary"));
  expectSameNode(document.activeElement, by("target"));
});

test("focus that had already fallen to the page is picked up when the form locks", () => {
  const focus = holdFocus();
  (document.activeElement as HTMLElement | null)?.blur?.();
  focus.note(by("form"));
  focus.lock(by("primary"));
  expectSameNode(document.activeElement, by("primary"));
});
