import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindOverlayOrigin, contextOrigin, noteOverlayOrigin, overlayOrigin } from "./origin";

let release = () => {};
let button: HTMLButtonElement;

beforeEach(async () => {
  await resetBoardTestDOM();
  button = document.createElement("button");
  document.body.append(button);
  release = bindOverlayOrigin(document);
});
afterEach(() => { release(); button.remove(); });

function press(pointerType: string, init: Record<string, unknown> = {}): void {
  button.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 40, clientY: 60, ...init }) as unknown as Event);
}
function context(init: Record<string, unknown> = {}): void {
  button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 44, clientY: 66, ...init }) as unknown as Event);
}

test("a press is remembered with its input and position", () => {
  press("mouse");
  expect(overlayOrigin()).toEqual({ input: "mouse", target: button, x: 40, y: 60, atPointer: false });
  press("touch");
  expect(overlayOrigin()?.input).toBe("touch");
  press("pen");
  expect(overlayOrigin()?.input).toBe("pen");
});

test("a mouse context click belongs at the pointer; a finger's long press does not", () => {
  press("mouse", { button: 2 });
  expect(overlayOrigin()?.atPointer).toBeTrue();
  context();
  expect(overlayOrigin()).toEqual({ input: "mouse", target: button, x: 44, y: 66, atPointer: true });
  press("touch");
  context();
  expect(overlayOrigin()).toMatchObject({ input: "touch", atPointer: false });
});

test("a key names the focused control, and the context-menu key stays a key", () => {
  button.focus();
  button.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }) as unknown as Event);
  expect(overlayOrigin()).toEqual({ input: "key", target: button, x: 0, y: 0, atPointer: false });
  context();
  expect(overlayOrigin()).toMatchObject({ input: "key", target: button, atPointer: false });
});

test("the context-menu key stays a key in an engine that calls its event a mouse's", () => {
  button.focus();
  button.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }) as unknown as Event);
  // As Chromium raises it: typed as a mouse, at a point inside the focused control, with no button.
  const keyed = new happy.MouseEvent("contextmenu", { bubbles: true, clientX: 139, clientY: 555, button: -1 });
  Object.defineProperty(keyed, "pointerType", { value: "mouse" });
  Object.defineProperty(keyed, "target", { value: button });
  expect(contextOrigin(keyed as unknown as MouseEvent)).toEqual({ input: "key", target: button, x: 139, y: 555, atPointer: false });
  // A real context click right after a key (a modifier held, say) is still the mouse's, at the pointer.
  const clicked = new happy.MouseEvent("contextmenu", { bubbles: true, clientX: 44, clientY: 66, button: 2 });
  Object.defineProperty(clicked, "pointerType", { value: "mouse" });
  expect(contextOrigin(clicked as unknown as MouseEvent)).toMatchObject({ input: "mouse", atPointer: true });
});

test("an engine that types its context-menu event overrides the remembered input", () => {
  press("mouse");
  const typed = new happy.MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 2 });
  Object.defineProperty(typed, "pointerType", { value: "touch" });
  expect(contextOrigin(typed as unknown as MouseEvent)).toMatchObject({ input: "touch", atPointer: false });
});

test("nothing is remembered without the page binding, and release forgets", () => {
  press("mouse");
  release();
  expect(overlayOrigin()).toBeNull();
  press("mouse");
  noteOverlayOrigin({ input: "mouse", target: button, x: 1, y: 1, atPointer: true });
  expect(overlayOrigin()).toBeNull();
  release();
  release = bindOverlayOrigin(document);
  noteOverlayOrigin({ input: "mouse", target: button, x: 1, y: 1, atPointer: true });
  expect(overlayOrigin()?.atPointer).toBeTrue();
});
