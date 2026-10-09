import { expectSameNode, expectSameNodes } from "../../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tabStops, trapTab } from "./tab-stops";

/**
 * What Tab stops at inside a dialog, and the wrap that keeps it there. The
 * browser moves focus between the stops itself; only the two ends are ours.
 */
let host: HTMLDivElement;
const by = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;

function tab(target: Element, init: Record<string, unknown> = {}): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  host.addEventListener("keydown", (pressed) => trapTab(host, pressed as KeyboardEvent), { once: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  await resetTestDOM();
  host = document.createElement("div");
  host.tabIndex = -1;
  document.body.append(host);
});
afterEach(() => host.remove());

test("the stops are the controls a key can reach, in document order", () => {
  host.innerHTML = `
    <button id="first">a</button>
    <button id="off" disabled>b</button>
    <fieldset disabled><input id="locked"></fieldset>
    <div hidden><button id="hidden">c</button></div>
    <input id="secret" type="hidden">
    <button id="roving" tabindex="-1">d</button>
    <details><summary id="fold">more</summary><input id="folded"></details>
    <details open><summary id="open">more</summary><input id="shown"></details>
    <a id="link" href="#x">e</a><a id="anchor">f</a>
    <span id="made" tabindex="0">g</span>
    <textarea id="last"></textarea>`;
  expectSameNodes(tabStops(host), ["first", "fold", "open", "shown", "link", "made", "last"].map(by));
});

test("Tab past the last stop starts over, and Shift+Tab before the first reaches the last", () => {
  host.innerHTML = `<input id="one"><button id="two">b</button><button id="three">c</button>`;
  by("two").focus();
  // In the middle the key is the browser's.
  expect(tab(by("two")).defaultPrevented).toBeFalse();
  expect(tab(by("two"), { shiftKey: true }).defaultPrevented).toBeFalse();
  by("three").focus();
  expect(tab(by("three")).defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, by("one"));
  expect(tab(by("one"), { shiftKey: true }).defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, by("three"));
});

test("focus resting on the dialog itself enters at the matching end", () => {
  host.innerHTML = `<input id="one"><button id="two">b</button>`;
  host.focus();
  expect(tab(host).defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, by("one"));
  host.focus();
  expect(tab(host, { shiftKey: true }).defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, by("two"));
});

test("a dialog with nothing to stop at keeps the key from leaving, and other keys are not its business", () => {
  host.innerHTML = `<p>nothing here</p>`;
  expect(tab(host).defaultPrevented).toBeTrue();
  host.innerHTML = `<input id="one"><button id="two">b</button>`;
  by("two").focus();
  expect(tab(by("two"), { key: "Enter" }).defaultPrevented).toBeFalse();
  expect(tab(by("two"), { ctrlKey: true }).defaultPrevented).toBeFalse();
  expectSameNode(document.activeElement, by("two"));
});

test("a surface that walks its own stops has answered already", () => {
  host.innerHTML = `<input id="one"><button id="two">b</button>`;
  by("two").focus();
  by("two").addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  tab(by("two"));
  expectSameNode(document.activeElement, by("two"));
});
