import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { bindSwipeRow } from "./swipe-row";

let release: () => void = () => undefined;

function build(canRead = false) {
  const row = document.createElement("article");
  const action = document.createElement("button");
  const main = document.createElement("button");
  row.append(action, main);
  document.body.append(row);
  const events: string[] = [];
  action.addEventListener("click", () => events.push("action"));
  main.addEventListener("click", () => events.push("open"));
  release = bindSwipeRow(row, {
    foreground: () => main,
    trailingWidth: 144,
    canCommitRight: () => canRead,
    onCommitRight: () => events.push("read"),
  });
  return { row, action, main, events };
}

function pointer(target: Element, type: string, x: number, pointerType = "touch"): void {
  target.dispatchEvent(new happy.PointerEvent(type, {
    bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType, clientX: x, clientY: 20,
  }) as unknown as Event);
}

function drag(target: Element, from: number, to: number, pointerType = "touch"): void {
  pointer(target, "pointerdown", from, pointerType);
  for (let step = 1; step <= 6; step++) pointer(target, "pointermove", from + ((to - from) * step) / 6, pointerType);
  pointer(target, "pointerup", to, pointerType);
}

beforeEach(async () => {
  await resetBoardTestDOM();
});

afterEach(() => {
  release();
});

describe("swipe row", () => {
  test("a left swipe opens the trailing actions and a later tap on one still runs", () => {
    const { row, action, main, events } = build();
    drag(main, 300, 120);
    expect(row.classList.contains("is-open")).toBe(true);
    expect(main.style.transform).toBe("translateX(-144px)");
    // A real touch swipe ends without a click; the next tap is an ordinary one.
    pointer(action, "pointerdown", 350);
    pointer(action, "pointerup", 350);
    action.click();
    expect(events).toEqual(["action"]);
    expect(row.classList.contains("is-open")).toBe(false);
  });

  test("the click that ends a swipe never opens the pane, and a tap on an open row only closes it", () => {
    const { row, main, events } = build();
    drag(main, 300, 120);
    main.click();
    expect(events).toEqual([]);
    expect(row.classList.contains("is-open")).toBe(true);
    pointer(main, "pointerdown", 200);
    pointer(main, "pointerup", 200);
    main.click();
    expect(events).toEqual([]);
    expect(row.classList.contains("is-open")).toBe(false);
    main.click();
    expect(events).toEqual(["open"]);
  });

  test("a right swipe commits only when allowed, and a mouse never swipes", () => {
    const allowed = build(true);
    drag(allowed.main, 60, 220);
    expect(allowed.events).toEqual(["read"]);
    release();
    const blocked = build(false);
    drag(blocked.main, 60, 220);
    expect(blocked.events).toEqual([]);
    expect(blocked.main.style.transform).toBe("");
    drag(blocked.main, 300, 100, "mouse");
    expect(blocked.row.classList.contains("is-open")).toBe(false);
  });

  test("only a row pulled to the right is marked as showing its leading action", () => {
    const { row, main } = build(true);
    pointer(main, "pointerdown", 100);
    pointer(main, "pointermove", 160);
    expect(row.classList.contains("is-leading")).toBe(true);
    // Back across the rest position and on to the left: the trailing pair's side.
    pointer(main, "pointermove", 40);
    expect(row.classList.contains("is-leading")).toBe(false);
    pointer(main, "pointerup", 0);
    drag(main, 300, 120);
    expect(row.classList.contains("is-open")).toBe(true);
    expect(row.classList.contains("is-leading")).toBe(false);
  });

  test("releasing the binding settles a row it left open", () => {
    const { row, main } = build();
    drag(main, 300, 120);
    expect(row.classList.contains("is-open")).toBe(true);
    release();
    expect(row.classList.contains("is-open")).toBe(false);
    expect(main.style.transform).toBe("");
  });
});
