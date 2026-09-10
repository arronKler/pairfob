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
  document.body.replaceChildren();
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

  test("only a selected chip is revealed", () => {
    const root = element("board-shell");
    const plain = element("board-chip");
    const on = spyScroll(element("board-chip on"));
    root.append(plain, on);
    document.body.append(root);
    revealSelection(root);
    expect(revealed).toEqual(["board-chip on"]);
  });

  test("measuring happens on a frame, and disposing cancels it", async () => {
    const root = element("board-shell");
    const spaceRail = element("board-rail");
    const spaces = element("board-spaces", { scrollWidth: 500, clientWidth: 100 });
    const tabRail = element("board-rail");
    const tabs = element("board-tabs", { scrollWidth: 50, clientWidth: 100 });
    const chip = spyScroll(element("board-tab on"));
    root.append(spaceRail, tabRail, chip);
    spaceRail.append(spaces);
    tabRail.append(tabs);
    document.body.append(root);

    const cancel = scheduleRailVisibility({ root, spaceRail, spaces, tabRail, tabs });
    expect(spaceRail.classList.contains("overflow")).toBe(false);
    await settle();
    expect(spaceRail.classList.contains("overflow")).toBe(true);
    expect(tabRail.classList.contains("overflow")).toBe(false);
    expect(revealed).toEqual(["board-tab on"]);

    spaceRail.classList.remove("overflow");
    const cancelled = scheduleRailVisibility({ root, spaceRail, spaces, tabRail, tabs });
    cancelled();
    await settle();
    expect(spaceRail.classList.contains("overflow")).toBe(false);
    expect(revealed).toEqual(["board-tab on"]);
    cancel();
  });

  test("a screen that has not mounted its rails measures nothing", async () => {
    const cancel = scheduleRailVisibility({ root: null, spaceRail: null, spaces: null, tabRail: null, tabs: null });
    await settle();
    expect(revealed).toEqual([]);
    cancel();
  });
});
