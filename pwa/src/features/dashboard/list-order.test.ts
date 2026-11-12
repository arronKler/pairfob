import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { resetHerdPresentationChoices, setListGroup } from "../settings/preferences-store";
import { heldShownListOrder, herdListScope, rememberShownListOrder, resetShownListOrder } from "./list-order";

beforeEach(async () => {
  await resetBoardTestDOM();
  resetHerdPresentationChoices();
  setListGroup("flat");
  resetShownListOrder();
});

afterEach(() => {
  resetShownListOrder();
});

describe("the order the herd list last showed", () => {
  test("keeps its stamps while the live order moves on", () => {
    rememberShownListOrder({ p1: 10, p2: 20 }, ["p1", "p2"]);
    expect(heldShownListOrder({ p1: 10, p2: 30, p3: 40 }, ["p1", "p2", "p3"]))
      .toEqual({ p1: 10, p2: 20, p3: 40 });
  });

  test("a later row takes the live stamp it has at that moment", () => {
    rememberShownListOrder({ p1: 10 }, ["p1"]);
    expect(heldShownListOrder({ p1: 10, p4: 50 }, ["p1", "p4"])).toEqual({ p1: 10, p4: 50 });
    expect(heldShownListOrder({ p1: 10, p4: 90 }, ["p1", "p4"])).toEqual({ p1: 10, p4: 90 });
  });

  test("another list falls back to the live activation", () => {
    rememberShownListOrder({ p1: 10, p2: 20 }, ["p1", "p2"]);
    expect(herdListScope().endsWith("\u0000flat")).toBeTrue();
    setListGroup("space");
    const live = { p1: 10, p2: 90 };
    expect(heldShownListOrder(live, ["p1", "p2"])).toEqual(live);
  });

  test("a reset forgets the list", () => {
    rememberShownListOrder({ p1: 10, p2: 20 }, ["p1", "p2"]);
    resetShownListOrder();
    const live = { p1: 10, p2: 90 };
    expect(heldShownListOrder(live, ["p1", "p2"])).toEqual(live);
  });
});
