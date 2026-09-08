import { Window } from "happy-dom";
import { afterEach, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair" });
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "sessionStorage"] as const) {
  globals[name] = (happy as unknown as Record<string, unknown>)[name];
}
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';
const { bindObjectPress } = await import("./press-menu");
let cleanup = () => {};
afterEach(() => { cleanup(); happy.document.querySelectorAll("button").forEach(button => button.remove()); });

function target() {
  const button = happy.document.createElement("button");
  happy.document.body.append(button);
  return button as unknown as HTMLButtonElement;
}

test("right click opens once and consumes its following click", () => {
  const button = target();
  let opens = 0;
  let clicks = 0;
  cleanup = bindObjectPress(button, () => opens++);
  button.addEventListener("click", () => clicks++);
  button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  button.click();
  expect(opens).toBe(1);
  expect(clicks).toBe(0);
  button.click();
  expect(clicks).toBe(1);
});

test("disposing a press cancels its hold timer and removes context listeners", async () => {
  const button = target();
  let opens = 0;
  cleanup = bindObjectPress(button, () => opens++);
  button.dispatchEvent(new happy.PointerEvent("pointerdown", {
    bubbles: true, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10,
  }) as unknown as Event);
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 480));
  button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(opens).toBe(0);
});

test("rebinding after cleanup keeps only the latest menu action", () => {
  const button = target();
  const calls: string[] = [];
  bindObjectPress(button, () => calls.push("old"))();
  cleanup = bindObjectPress(button, () => calls.push("new"));
  button.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(calls).toEqual(["new"]);
});
