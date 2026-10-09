import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { declineModifiedPress, isPlainPress } from "./plain-press";

/**
 * A button is pressed by plain Enter or Space. Enter with a modifier is not a
 * press: a router that takes it also has to stop the browser pressing the button.
 */
const key = (name: string, init: Record<string, unknown> = {}) =>
  new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;

function pressOn(html: string, event: KeyboardEvent): KeyboardEvent {
  document.body.insertAdjacentHTML("beforeend", `<div id="plain-press">${html}</div>`);
  document.querySelector("#plain-press [data-target]")!.dispatchEvent(event);
  return event;
}
beforeEach(async () => { await resetTestDOM(); });
afterEach(() => document.getElementById("plain-press")?.remove());

test("plain Enter and Space press; any modifier makes Enter something else", () => {
  expect(isPlainPress(key("Enter"))).toBeTrue();
  expect(isPlainPress(key(" "))).toBeTrue();
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
    expect(isPlainPress(key("Enter", { [modifier]: true })), modifier).toBeFalse();
    expect(isPlainPress(key(" ", { [modifier]: true })), modifier).toBeFalse();
  }
  expect(isPlainPress(key("a"))).toBeFalse();
  expect(isPlainPress(key("Tab"))).toBeFalse();
});

test("a modified Enter on a button, or on what a button holds, is declined; the plain press and other targets are left alone", () => {
  const onButton = pressOn(`<button data-target>more</button>`, key("Enter", { shiftKey: true }));
  expect(declineModifiedPress(onButton)).toBeTrue();
  expect(onButton.defaultPrevented).toBeTrue();
  document.getElementById("plain-press")!.remove();

  const inside = pressOn(`<button><span data-target>icon</span></button>`, key("Enter", { ctrlKey: true }));
  expect(declineModifiedPress(inside)).toBeTrue();
  document.getElementById("plain-press")!.remove();

  const plain = pressOn(`<button data-target>more</button>`, key("Enter"));
  expect(declineModifiedPress(plain)).toBeFalse();
  expect(plain.defaultPrevented).toBeFalse();
  document.getElementById("plain-press")!.remove();

  const field = pressOn(`<textarea data-target></textarea>`, key("Enter", { shiftKey: true }));
  expect(declineModifiedPress(field)).toBeFalse();
  expect(field.defaultPrevented).toBeFalse();
  document.getElementById("plain-press")!.remove();

  const space = pressOn(`<button data-target>more</button>`, key(" ", { shiftKey: true }));
  expect(declineModifiedPress(space)).toBeFalse();
});
