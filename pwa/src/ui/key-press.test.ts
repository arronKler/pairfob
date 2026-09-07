import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bindPadPress, REPEAT_DELAY_MS, REPEAT_EVERY_MS } from "./key-press";

const happy = new Window({ url: "https://pairfob.com/pair" });
const stops: Array<() => void> = [];

function setup(repeat = false) {
  const input = happy.document.createElement("textarea");
  const button = happy.document.createElement("button");
  button.type = "button";
  happy.document.body.append(input, button);
  input.value = "terminal draft";
  input.focus();
  input.setSelectionRange(2, 6);
  let count = 0;
  const releases: boolean[] = [];
  stops.push(bindPadPress(button as unknown as HTMLElement, () => { count++; }, {
    repeat,
    release: (cancelled) => releases.push(cancelled),
  }).stop);
  const pointer = (type: string, init: PointerEventInit = {}) => {
    const event = new happy.PointerEvent(type, {
      pointerId: 1, button: 0, pointerType: "touch", bubbles: true, cancelable: true, ...init,
    });
    button.dispatchEvent(event);
    return event;
  };
  return { input, button, pointer, releases, count: () => count };
}

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  happy.document.body.replaceChildren();
});

describe("pad physical press ownership", () => {
  test("keeps focus and selection, gives press feedback and consumes the matching click once", () => {
    const { input, button, pointer, count, releases } = setup();
    expect(pointer("pointerdown").defaultPrevented).toBe(true);
    expect(happy.document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    expect(button.classList.contains("is-pressed")).toBe(true);
    pointer("pointerdown");
    pointer("pointerup");
    pointer("lostpointercapture");
    button.dispatchEvent(new happy.MouseEvent("click", { detail: 1 }));
    pointer("click", { detail: 0 });
    expect(count()).toBe(1);
    expect(releases).toEqual([false]);
    expect(button.classList.contains("is-pressed")).toBe(false);
    // No debounce window: another deliberate tap must not be swallowed.
    pointer("pointerdown");
    pointer("pointerup");
    expect(count()).toBe(2);
  });

  test("a second finger cannot fire or release the first finger's button", () => {
    const { pointer, count, releases, button } = setup();
    pointer("pointerdown");
    pointer("pointerdown", { pointerId: 2 });
    pointer("pointerup", { pointerId: 2 });
    expect(count()).toBe(1);
    expect(releases).toEqual([]);
    expect(button.classList.contains("is-pressed")).toBe(true);
    pointer("pointerup");
    expect(releases).toEqual([false]);
  });

  test("keyboard and assistive clicks activate without requiring a pointer", () => {
    const { button, count, releases } = setup();
    button.click();
    button.click();
    expect(count()).toBe(2);
    expect(releases).toEqual([false, false]);
  });

  test("ignores disabled controls and non-left mouse buttons", () => {
    const { button, pointer, count } = setup();
    pointer("pointerdown", { button: 2, pointerType: "mouse" });
    pointer("pointerdown", { button: 1, pointerType: "mouse" });
    button.disabled = true;
    pointer("pointerdown");
    button.disabled = false;
    button.setAttribute("aria-disabled", "true");
    pointer("pointerdown");
    button.click();
    expect(count()).toBe(0);
    expect(button.classList.contains("is-pressed")).toBe(false);
  });

  test("document pointerup releases a key even when the pointer ends elsewhere", () => {
    const { pointer, releases, button } = setup();
    pointer("pointerdown");
    happy.document.dispatchEvent(new happy.PointerEvent("pointerup", { pointerId: 1 }));
    expect(releases).toEqual([false]);
    expect(button.classList.contains("is-pressed")).toBe(false);
  });

  test("cancel and lost capture end a gesture once without a successful release", () => {
    const { pointer, releases } = setup();
    pointer("pointerdown");
    pointer("pointercancel");
    pointer("lostpointercapture");
    pointer("pointerup");
    expect(releases).toEqual([true]);
  });

  test("moving outside an implicitly captured touch cancels the hold", () => {
    const { pointer, releases, button } = setup();
    button.getBoundingClientRect = () => new happy.DOMRect(10, 10, 44, 44);
    pointer("pointerdown", { clientX: 20, clientY: 20 });
    pointer("pointermove", { clientX: 100, clientY: 20 });
    expect(releases).toEqual([true]);
    expect(button.classList.contains("is-pressed")).toBe(false);
  });

  test("leaving the window stops long-press repeats", async () => {
    const { pointer, count, releases } = setup(true);
    pointer("pointerdown");
    happy.dispatchEvent(new happy.Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, REPEAT_DELAY_MS + REPEAT_EVERY_MS * 2));
    expect(count()).toBe(1);
    expect(releases).toEqual([true]);
  });

  test("backgrounding the page cancels a held key and clears press feedback", () => {
    const { pointer, button, releases } = setup(true);
    pointer("pointerdown");
    Object.defineProperty(happy.document, "hidden", { configurable: true, value: true });
    try {
      happy.document.dispatchEvent(new happy.Event("visibilitychange"));
      expect(releases).toEqual([true]);
      expect(button.classList.contains("is-pressed")).toBe(false);
    } finally {
      Reflect.deleteProperty(happy.document, "hidden");
    }
  });

  test("repeats only while held, and stops when the button is detached", async () => {
    const { pointer, count, button, releases } = setup(true);
    pointer("pointerdown");
    await new Promise((resolve) => setTimeout(resolve, REPEAT_DELAY_MS + REPEAT_EVERY_MS * 2));
    expect(count()).toBeGreaterThan(1);
    button.remove();
    const detachedCount = count();
    await new Promise((resolve) => setTimeout(resolve, REPEAT_EVERY_MS * 2));
    expect(count()).toBe(detachedCount);
    expect(releases).toEqual([true]);
  });
});
