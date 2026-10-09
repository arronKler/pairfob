import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isDesk } from "../../app/viewport";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { buildHerdViewModel } from "../../features/dashboard/model/herd-view";
import { paneActivated, rememberPane, resetHerdPresentationChoices, setListGroup } from "../../features/settings/preferences-store";
import { setLang } from "../../lib/i18n";
import { readHerdAttention, readHerdInput, resetHerdListOrder } from "./herd-bridge";

function seed(ids: string[]): void {
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:tab", workspace_id: "w", label: "main" }],
    panes: ids.map((id) => ({ pane_id: id, workspace_id: "w", tab_id: "w:tab", cwd: "/tmp/w", agent: "codex", agent_status: "idle", label: id })),
  });
}

function size(width: number, height: number): void {
  happy.happyDOM.setWindowSize({ width, height });
}

function visible(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

/** The rows as the list shows them, top to bottom. */
function rows(): string[] {
  return buildHerdViewModel(readHerdInput(readHerdAttention())).groups.flatMap((group) => group.cards.map((card) => card.paneId));
}

/** Open a pane the way a tap does, at a moment later than every earlier open. */
let clock = 1_000;
function open(paneId: string): void {
  const now = Date.now;
  Date.now = () => (clock += 1_000);
  try { rememberPane(paneId); } finally { Date.now = now; }
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  visible("visible");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  resetHerdListOrder();
  seed(["p1", "p2", "p3"]);
});

afterEach(() => {
  resetHerdListOrder();
  resetDashboard();
  resetHerdPresentationChoices();
  size(390, 844);
  visible("hidden");
});

describe("list order while the list stays on screen", () => {
  test("beside the session an open does not move the row; the next build of the list adopts it", () => {
    size(1440, 900);
    expect(isDesk()).toBe(true);
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    open("p3");
    // The live record did move: search-and-jump's recent section reads that one.
    expect(paneActivated().p3).toBeGreaterThan(0);
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    open("p2");
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    // Another grouping is another list.
    setListGroup("space");
    expect(rows()).toEqual(["p2", "p3", "p1"]);
  });

  test("coming back to the tab is a fresh look at the list", () => {
    size(1440, 900);
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    open("p3");
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    visible("hidden");
    rows();
    visible("visible");
    expect(rows()).toEqual(["p3", "p1", "p2"]);
  });

  test("a session that turns up later takes its place once and keeps it", () => {
    size(1440, 900);
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    seed(["p1", "p2", "p3", "p4"]);
    expect(rows()).toEqual(["p1", "p2", "p3", "p4"]);
    open("p4");
    expect(rows()).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("the phone keeps its rule: the pane opened last leads when the list is shown again", () => {
    size(390, 844);
    expect(isDesk()).toBe(false);
    expect(rows()).toEqual(["p1", "p2", "p3"]);
    open("p3");
    expect(rows()).toEqual(["p3", "p1", "p2"]);
    open("p2");
    expect(rows()).toEqual(["p2", "p3", "p1"]);
  });
});
