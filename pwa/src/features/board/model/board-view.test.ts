import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import type { BoardSpace, BoardTab, TabLayout } from "../../../lib/layout";
import {
  boardTabAnchor,
  boardTabLabel,
  boardTiles,
  boardWorkspaceLabel,
  buildBoardViewModel,
  firstTabInWorkspace,
  type BoardModelInput,
} from "./board-view";

function agent(id: string, workspaceId: string, tabId: string, extra: Partial<DashboardAgentCard> = {}): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "claude", hasAgent: true, status: "idle",
    workspaceId, workspaceLabel: workspaceId, tabId, cwd: `/tmp/${workspaceId}`, ...extra,
  };
}

function layout(panes: Array<{ paneId: string; focused: boolean; rect: { x: number; y: number; width: number; height: number } }>,
  extra: Partial<TabLayout> = {}): TabLayout {
  return {
    workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: panes[0]?.paneId ?? "",
    area: { x: 0, y: 0, width: 100, height: 40 }, panes, ...extra,
  };
}

function input(overrides: Partial<BoardModelInput> = {}): BoardModelInput {
  return {
    workspaceList: [],
    tabList: [],
    agents: [],
    layouts: [],
    workspaceId: "",
    tabId: "",
    selectedPaneId: "",
    status: { tone: "live", text: "connected" },
    canCreateTab: false,
    operationBusy: false,
    connected: true,
    ...overrides,
  };
}

const spaces: BoardSpace[] = [{ id: "w1", label: "pairfob" }, { id: "w2", label: "pairfob" }];
const tabs: BoardTab[] = [
  { id: "w1:t1", workspaceId: "w1", label: "main" },
  { id: "w1:t2", workspaceId: "w1", label: "logs" },
  { id: "w2:t1", workspaceId: "w2", label: "3" },
];

beforeEach(() => setLang("zh"));

describe("board rail labels", () => {
  test("a duplicate workspace name keeps a folder tail", () => {
    const agents = [agent("w1:p1", "w1", "w1:t1", { cwd: "/tmp/test/pairfob" }), agent("w2:p1", "w2", "w2:t1", { cwd: "/tmp/github/pairfob" })];
    expect(boardWorkspaceLabel(spaces[0], spaces, agents)).toBe("pairfob · test/pairfob");
    expect(boardWorkspaceLabel(spaces[1], spaces, agents)).toBe("pairfob · github/pairfob");
    expect(boardWorkspaceLabel({ id: "w3", label: "" }, [{ id: "w3", label: "" }], [])).toBe(t("workspace.unnamed"));
  });

  test("a hidden or numeric tab label falls back to split size, then position", () => {
    const agents = [agent("w1:p1", "w1", "w1:t1"), agent("w1:p2", "w1", "w1:t1")];
    expect(boardTabLabel(tabs[0], 0, agents)).toBe(t("detail.splitCount", { n: 2 }));
    expect(boardTabLabel(tabs[1], 1, [])).toBe("logs");
    expect(boardTabLabel(tabs[2], 0, [])).toBe(t("board.tabIndex", { n: 1 }));
  });

  test("selecting a chip focuses the first tab of that workspace", () => {
    expect(firstTabInWorkspace(tabs, "w1")).toBe("w1:t1");
    expect(firstTabInWorkspace(tabs, "w2")).toBe("w2:t1");
    expect(firstTabInWorkspace(tabs, "w9")).toBe("");
  });

  test("a new tab anchors on the shown tab, then the workspace, then nothing", () => {
    const agents = [agent("p1", "w1", "w1:t1"), agent("p2", "w1", "w1:t2"), agent("p3", "w2", "w2:t1")];
    expect(boardTabAnchor(agents, "w1", "w1:t2")?.paneId).toBe("p2");
    expect(boardTabAnchor(agents, "w1", "w1:t9")?.paneId).toBe("p1");
    expect(boardTabAnchor(agents, "w9", "")).toBeUndefined();
  });
});

describe("board canvas tiles", () => {
  test("tiles keep pane identity, geometry, status pill and focus class", () => {
    const tiles = boardTiles(layout([
      { paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
      { paneId: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
    ]), [agent("w1:p1", "w1", "w1:t1", { paneLabel: "one" }), agent("w1:p2", "w1", "w1:t1", { status: "working", paneLabel: "two" })], "w1:p2");
    expect(tiles.map((tile) => tile.paneId)).toEqual(["w1:p1", "w1:p2"]);
    expect(tiles[0].box).toMatchObject({ left: 0, top: 0, width: 480, height: 640, focused: true });
    expect(tiles[1].box).toMatchObject({ left: 480, width: 320 });
    expect(tiles[0].className).toBe("board-pane status-idle focused");
    expect(tiles[1].className).toBe("board-pane status-working sel");
    expect(tiles[1].selected).toBe(true);
    expect(tiles[1].pill).toBe(t("status.working"));
    expect(tiles[0].pill).toBe(t("status.idle"));
    expect(tiles[0].aria).toBe(t("board.paneAria", { title: "one" }));
    expect(tiles[0].cols).toBe(60);
    expect(tiles[0].rows).toBe(40);
    expect(tiles[0].zoomed).toBe(false);
  });

  test("a zoomed layout marks the focused tile only", () => {
    const zoomed = layout([
      { paneId: "w1:p1", focused: false, rect: { x: 0, y: 0, width: 50, height: 40 } },
      { paneId: "w1:p2", focused: true, rect: { x: 50, y: 0, width: 50, height: 40 } },
    ], { zoomed: true, focusedPaneId: "w1:p2" });
    expect(boardTiles(zoomed, [], "").map((tile) => tile.zoomed)).toEqual([false, true]);
  });

  test("a pane the snapshot no longer reports still paints, without a pill", () => {
    const tiles = boardTiles(layout([{ paneId: "gone", focused: true, rect: { x: 0, y: 0, width: 10, height: 10 } }]), [], "");
    expect(tiles[0].title).toBe("gone");
    expect(tiles[0].status).toBe("idle");
    expect(tiles[0].pill).toBe("");
  });
});

describe("board screen projection", () => {
  test("rails, chrome copy and the selected workspace follow the record", () => {
    const view = buildBoardViewModel(input({
      workspaceList: spaces, tabList: tabs, workspaceId: "w1", tabId: "w1:t2",
      agents: [agent("w1:p1", "w1", "w1:t2", { cwd: "/tmp/test/pairfob" }), agent("w2:p1", "w2", "w2:t1", { cwd: "/tmp/github/pairfob" })],
    }));
    expect(view.title).toBe(t("board.title"));
    expect(view.back).toBe(t("board.back"));
    expect(view.sub).toBe("pairfob · test/pairfob");
    expect(view.spaces.map((space) => [space.id, space.selected])).toEqual([["w1", true], ["w2", false]]);
    expect(view.tabs.map((tab) => tab.id)).toEqual(["w1:t1", "w1:t2"]);
    expect(view.tabs[1].selected).toBe(true);
    expect(view.zoom).toEqual({ out: t("board.zoomOut"), fit: t("board.fitAria"), fitLabel: t("board.fit"), in: t("board.zoomIn") });
    expect(view.canvas.canvasAria).toBe(t("board.canvasAria"));
  });

  test("a workspace the snapshot dropped leaves the subtitle empty, not invented", () => {
    const view = buildBoardViewModel(input({ workspaceList: spaces, tabList: tabs, workspaceId: "w9", tabId: "" }));
    expect(view.sub).toBeNull();
    expect(view.tabs).toEqual([]);
    expect(view.spaces.every((space) => !space.selected)).toBe(true);
  });

  test("an empty catalog explains itself and the canvas has no layout", () => {
    const view = buildBoardViewModel(input());
    expect(view.spaces).toEqual([]);
    expect(view.spacesEmpty).toBe(t("board.empty"));
    expect(view.canvas.layout).toBeNull();
    expect(view.canvas.size).toBeNull();
    expect(view.canvas.tiles).toEqual([]);
    expect(view.canvas.emptyTitle).toBe(t("board.emptyTitle"));
    expect(view.canvas.emptySub).toBe(t("board.empty"));
  });

  test("the canvas signature changes with the resolved layout, not the catalog", () => {
    const explicit = layout([{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }]);
    const first = buildBoardViewModel(input({ tabId: "w1:t1", layouts: [explicit] }));
    expect(first.canvas.signature).toBe(JSON.stringify(explicit));
    expect(first.canvas.size).toEqual({ width: 800, height: 640 });
    const same = buildBoardViewModel(input({ tabId: "w1:t1", layouts: [explicit] }));
    expect(same.canvas.signature).toBe(first.canvas.signature);
    // A tab with panes but no explicit layout resolves the same fallback shape,
    // so the canvas still rebinds when the resolved layout changes.
    const fallback = buildBoardViewModel(input({
      tabId: "w1:t1",
      layouts: [],
      agents: [agent("w1:p1", "w1", "w1:t1"), agent("w1:p2", "w1", "w1:t1")],
    }));
    expect(fallback.canvas.signature).not.toBe(first.canvas.signature);
    expect(fallback.canvas.layout?.area).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(fallback.canvas.tiles.map((tile) => tile.paneId)).toEqual(["w1:p1", "w1:p2"]);
    // No layout at all is a different signature again, and paints no stage.
    const none = buildBoardViewModel(input({ tabId: "w1:t9", layouts: [explicit] }));
    expect(none.canvas.signature).toBe("null");
    expect(none.canvas.layout).toBeNull();
    expect(none.canvas.size).toBeNull();
  });

  test("new tab fails closed: no capability means no control at all", () => {
    expect(buildBoardViewModel(input({ workspaceId: "w1" })).create).toBeNull();
    expect(buildBoardViewModel(input({ workspaceId: "w1", canCreateTab: true })).create)
      .toEqual({ label: t("board.newTab"), disabled: false });
    expect(buildBoardViewModel(input({ workspaceId: "w1", canCreateTab: true, operationBusy: true })).create)
      .toEqual({ label: t("home.creating"), disabled: true });
    expect(buildBoardViewModel(input({ workspaceId: "w1", canCreateTab: true, connected: false })).create?.disabled).toBe(true);
    expect(buildBoardViewModel(input({ workspaceId: "", canCreateTab: true })).create?.disabled).toBe(true);
  });
});
