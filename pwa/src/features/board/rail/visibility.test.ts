import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { markRailOverflow, RAIL_OVERFLOW_SLACK_PX, revealSelection, scheduleRailVisibility } from "./visibility";

function element(className: string, size: { scrollWidth?: number; clientWidth?: number } = {}): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  if (size.scrollWidth !== undefined) Object.defineProperty(node, "scrollWidth", { value: size.scrollWidth, configurable: true });
  if (size.clientWidth !== undefined) Object.defineProperty(node, "clientWidth", { value: size.clientWidth, configurable: true });
  return node;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 24));

let revealed: string[] = [];

/** happy-dom does not scroll; record the intent on the node instead. */
function spyScroll(node: HTMLElement): HTMLElement {
  node.scrollIntoView = () => revealed.push(node.className);
  return node;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  revealed = [];
});

afterEach(() => {
  for (const node of [...document.body.children]) if (node.id !== "app") node.remove();
});

describe("board rail visibility", () => {
  test("a rail that cannot show its chips gains the overflow affordance", () => {
    const rail = element("board-rail");
    const scroller = element("board-spaces", { scrollWidth: 400, clientWidth: 200 });
    markRailOverflow(rail, scroller);
    expect(rail.classList.contains("overflow")).toBe(true);
  });

  test("a rail that fits, or nearly fits, keeps no affordance", () => {
    const rail = element("board-rail");
    markRailOverflow(rail, element("board-spaces", { scrollWidth: 200, clientWidth: 200 }));
    expect(rail.classList.contains("overflow")).toBe(false);
    markRailOverflow(rail, element("board-spaces", { scrollWidth: 200 + RAIL_OVERFLOW_SLACK_PX, clientWidth: 200 }));
    expect(rail.classList.contains("overflow")).toBe(false);
    markRailOverflow(rail, element("board-spaces", { scrollWidth: 200 + RAIL_OVERFLOW_SLACK_PX + 1, clientWidth: 200 }));
    expect(rail.classList.contains("overflow")).toBe(true);
  });

  test("the overflow affordance is removed again once the rail fits", () => {
    const rail = element("board-rail");
    const scroller = element("board-tabs", { scrollWidth: 400, clientWidth: 100 });
    markRailOverflow(rail, scroller);
    Object.defineProperty(scroller, "scrollWidth", { value: 100, configurable: true });
    markRailOverflow(rail, scroller);
    expect(rail.classList.contains("overflow")).toBe(false);
  });

  test("only the selected tab is revealed", () => {
    const root = element("board-shell");
    const plain = element("board-tab");
    const on = spyScroll(element("board-tab on"));
    root.append(plain, on);
    document.body.append(root);
    revealSelection(root);
    expect(revealed).toEqual(["board-tab on"]);
  });

  test("measuring happens on a frame, and disposing cancels it", async () => {
    const root = element("board-shell");
    const tabRail = element("board-rail");
    const tabs = element("board-tabs", { scrollWidth: 500, clientWidth: 100 });
    const chip = spyScroll(element("board-tab on"));
    root.append(tabRail, chip);
    tabRail.append(tabs);
    document.body.append(root);

    const cancel = scheduleRailVisibility({ root, tabRail, tabs });
    expect(tabRail.classList.contains("overflow")).toBe(false);
    await settle();
    expect(tabRail.classList.contains("overflow")).toBe(true);
    expect(revealed).toEqual(["board-tab on"]);

    tabRail.classList.remove("overflow");
    const cancelled = scheduleRailVisibility({ root, tabRail, tabs });
    cancelled();
    await settle();
    expect(tabRail.classList.contains("overflow")).toBe(false);
    expect(revealed).toEqual(["board-tab on"]);
    cancel();
  });

  test("a screen that has not mounted its rails measures nothing", async () => {
    const cancel = scheduleRailVisibility({ root: null, tabRail: null, tabs: null });
    await settle();
    expect(revealed).toEqual([]);
    cancel();
  });
});
