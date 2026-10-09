import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { appRoot } from "../../../app/dom-root";
import { emulateTouchDevice } from "../touch-realm";
import { pageAgentStreamFromField, readAgentStream, readingScrollTop } from "./reading-keys";

/**
 * Reading a conversation from the keyboard. A browser scrolls only what has
 * focus, and a conversation opens with focus on the page or in its field, so
 * these keys are routed to the transcript by hand.
 */
const key = (name: string, init: Record<string, boolean> = {}) =>
  ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init });

describe("where a reading key takes the transcript", () => {
  // 600px of transcript on screen, 3000px in all: it can sit anywhere from 0 to 2400.
  const at = (name: string, top: number, init: Record<string, boolean> = {}) => readingScrollTop(key(name, init), top, 600, 3000);

  test("arrows step, PageUp and PageDown turn most of a screen", () => {
    expect(at("ArrowDown", 1000)).toBe(1040);
    expect(at("ArrowUp", 1000)).toBe(960);
    expect(at("PageDown", 1000)).toBe(1525);
    expect(at("PageUp", 1000)).toBe(475);
  });

  test("Home and End reach the two ends, and nothing passes them", () => {
    expect(at("Home", 1000)).toBe(0);
    expect(at("End", 1000)).toBe(2400);
    expect(at("PageUp", 100)).toBe(0);
    expect(at("PageDown", 2300)).toBe(2400);
    expect(at("ArrowUp", 0)).toBe(0);
    // A transcript shorter than its box has nowhere to go.
    expect(readingScrollTop(key("End"), 0, 600, 400)).toBe(0);
  });

  test("Space pages down and Shift+Space back up", () => {
    expect(at(" ", 1000)).toBe(1525);
    expect(at(" ", 1000, { shiftKey: true })).toBe(475);
  });

  test("a chord, a character and a shifted arrow are not reading keys", () => {
    expect(at("ArrowDown", 1000, { metaKey: true })).toBeNull();
    expect(at("PageDown", 1000, { ctrlKey: true })).toBeNull();
    expect(at("End", 1000, { altKey: true })).toBeNull();
    expect(at("ArrowDown", 1000, { shiftKey: true })).toBeNull();
    expect(at("j", 1000)).toBeNull();
    expect(at("Enter", 1000)).toBeNull();
  });
});

describe("the keys at the page", () => {
  let stream: HTMLElement;
  let field: HTMLTextAreaElement;
  let restoreTouch: (() => void) | null = null;

  function press(target: Node, name: string, init: Record<string, unknown> = {}): KeyboardEvent {
    let seen!: KeyboardEvent;
    const listen = (event: Event): void => { seen = event as KeyboardEvent; };
    target.addEventListener("keydown", listen, { once: true });
    target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as Event);
    return seen;
  }

  beforeEach(async () => {
    await resetBoardTestDOM();
    appRoot().innerHTML = `<header><button class="more">More</button></header>
      <div class="agent-stream" tabindex="0"><details><summary class="work-head">2 steps</summary></details></div>
      <div class="dock agent-dock"><textarea></textarea></div>`;
    stream = appRoot().querySelector(".agent-stream")!;
    field = appRoot().querySelector("textarea")!;
    Object.defineProperties(stream, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 3000 } });
    stream.scrollTop = 1000;
  });

  afterEach(() => {
    restoreTouch?.();
    restoreTouch = null;
    appRoot().innerHTML = "";
  });

  test("from the page or a button outside the transcript, a reading key scrolls it", () => {
    const down = press(document.body, "PageDown");
    expect(readAgentStream(down)).toBeTrue();
    expect([stream.scrollTop, down.defaultPrevented]).toEqual([1525, true]);
    expect(readAgentStream(press(appRoot().querySelector(".more")!, "ArrowUp"))).toBeTrue();
    expect(stream.scrollTop).toBe(1485);
    expect(readAgentStream(press(document.body, "Home"))).toBeTrue();
    expect(stream.scrollTop).toBe(0);
  });

  test("focus inside the transcript is the browser's to scroll, and a character is nobody's here", () => {
    for (const target of [stream, stream.querySelector("summary")!]) {
      const event = press(target, "PageDown");
      expect(readAgentStream(event)).toBeFalse();
      expect(event.defaultPrevented).toBeFalse();
    }
    expect(readAgentStream(press(document.body, "x"))).toBeFalse();
    expect(stream.scrollTop).toBe(1000);
  });

  test("on glass with no keyboard proven, nothing moves", () => {
    restoreTouch = emulateTouchDevice();
    const event = press(document.body, "PageDown");
    expect(readAgentStream(event)).toBeFalse();
    expect(pageAgentStreamFromField(press(field, "PageUp"), field)).toBeFalse();
    expect([stream.scrollTop, event.defaultPrevented]).toEqual([1000, false]);
  });

  test("PageUp and PageDown in the field page the transcript; its other keys stay its own", () => {
    expect(pageAgentStreamFromField(press(field, "PageUp"), field)).toBeTrue();
    expect(stream.scrollTop).toBe(475);
    expect(pageAgentStreamFromField(press(field, "PageDown"), field)).toBeTrue();
    expect(stream.scrollTop).toBe(1000);
    for (const name of ["ArrowUp", "ArrowDown", "Home", "End", " "]) {
      const event = press(field, name);
      expect(pageAgentStreamFromField(event, field), name).toBeFalse();
      expect(event.defaultPrevented, name).toBeFalse();
    }
    expect(pageAgentStreamFromField(press(field, "PageUp", { shiftKey: true }), field)).toBeFalse();
    expect(stream.scrollTop).toBe(1000);
  });

  test("a draft that scrolls inside the field keeps PageUp and PageDown for itself", () => {
    Object.defineProperties(field, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } });
    const event = press(field, "PageUp");
    expect(pageAgentStreamFromField(event, field)).toBeFalse();
    expect([stream.scrollTop, event.defaultPrevented]).toEqual([1000, false]);
  });
});
