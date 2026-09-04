import { describe, expect, test } from "bun:test";
import {
  catalogFromSnapshot,
  fallbackTabLayout,
  fitBoardCamera,
  initialBoardCamera,
  layoutForPane,
  layoutForTab,
  numberDuplicateTitles,
  paneBoxes,
  panePtySize,
  parseSnapshotLayouts,
  resolveBoardFocus,
  workspaceChipLabel,
} from "./layout.ts";
import type { AgentCard } from "./ranking.ts";

const agents: AgentCard[] = [
  {
    paneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
    agent: "claude",
    status: "idle",
    workspaceLabel: "alpha",
    cwd: "/tmp/a",
  },
  {
    paneId: "w1:p2",
    tabId: "w1:t1",
    workspaceId: "w1",
    agent: "codex",
    status: "working",
    workspaceLabel: "alpha",
    cwd: "/tmp/a",
  },
];

describe("tab layout mapping", () => {
  test("parses herdr pane rects into fractional boxes", () => {
    const layouts = parseSnapshotLayouts({
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          zoomed: false,
          focused_pane_id: "w1:p1",
          area: { x: 0, y: 0, width: 100, height: 40 },
          panes: [
            { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
            { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
          ],
        },
        { workspace_id: "nope", tab_id: "bad", area: { width: 0, height: 10 }, panes: [] },
      ],
    });
    expect(layouts).toHaveLength(1);
    const boxes = paneBoxes(layouts[0]);
    expect(boxes[0]).toEqual({ paneId: "w1:p1", focused: true, left: 0, top: 0, width: 0.6, height: 1 });
    expect(boxes[1].left).toBeCloseTo(0.6);
    expect(boxes[1].width).toBeCloseTo(0.4);
  });

  test("a stacked split keeps the TUI cell occupancy after subtracting the tab origin", () => {
    const layouts = parseSnapshotLayouts({
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          zoomed: false,
          focused_pane_id: "p1",
          area: { x: 26, y: 1, width: 213, height: 60 },
          panes: [
            { pane_id: "p1", focused: true, rect: { x: 26, y: 1, width: 107, height: 30 } },
            { pane_id: "p2", focused: false, rect: { x: 26, y: 31, width: 107, height: 30 } },
            { pane_id: "p3", focused: false, rect: { x: 133, y: 1, width: 106, height: 60 } },
          ],
        },
      ],
    });
    const boxes = paneBoxes(layouts[0]);
    expect(boxes[0].height).toBeCloseTo(0.5);
    expect(boxes[1].top).toBeCloseTo(0.5);
    expect(boxes[1].height).toBeCloseTo(0.5);
    expect(boxes[2].left).toBeCloseTo(107 / 213);
    expect(boxes[2].height).toBe(1);
  });

  test("falls back to equal columns when a tab has no layout", () => {
    const layout = layoutForTab("w1:t1", [], agents);
    expect(layout?.panes).toHaveLength(2);
    const boxes = paneBoxes(layout!);
    expect(boxes[0].width).toBeCloseTo(0.5);
    expect(boxes[1].left).toBeCloseTo(0.5);
  });

  test("a split pane keeps its layout cell grid for a phone open", () => {
    const layouts = parseSnapshotLayouts({
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          zoomed: false,
          focused_pane_id: "w1:p1",
          area: { x: 0, y: 0, width: 100, height: 40 },
          panes: [
            { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 52, height: 40 } },
            { pane_id: "w1:p2", focused: false, rect: { x: 52, y: 0, width: 48, height: 40 } },
          ],
        },
      ],
    });
    expect(layoutForPane("w1:p2", layouts, agents)?.tabId).toBe("w1:t1");
    expect(panePtySize("w1:p1", layouts, agents)).toEqual({ cols: 52, rows: 40 });
    expect(panePtySize("w1:p2", layouts, [{ ...agents[1], viewportRows: 24 }])).toEqual({ cols: 48, rows: 24 });
    expect(panePtySize("missing", layouts, agents)).toBeNull();
  });

  test("keeps the current workspace when switching focus locally", () => {
    const snapshot = {
      focused: { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" },
      workspaces: [
        { workspace_id: "w1", label: "alpha" },
        { workspace_id: "w2", label: "beta" },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "logs" },
      ],
    };
    const catalog = catalogFromSnapshot(snapshot, agents);
    expect(resolveBoardFocus("w1", "w1:t1", catalog, snapshot)).toEqual({
      workspaceId: "w1",
      tabId: "w1:t1",
    });
    expect(resolveBoardFocus("", "", catalog, snapshot)).toEqual({
      workspaceId: "w2",
      tabId: "w2:t1",
    });
  });

  test("fit camera shrinks a large tab into the viewport", () => {
    const camera = fitBoardCamera(200, 100, 960, 320);
    expect(camera.scale).toBeLessThan(1);
    expect(camera.scale).toBeGreaterThan(0.1);
    const fallback = fallbackTabLayout("w1", "w1:t1", ["w1:p1"]);
    expect(fallback?.area.width).toBe(120);
  });

  test("first open fits the whole tab so every pane is on screen", () => {
    const overview = fitBoardCamera(390, 844, 1704, 480);
    const open = initialBoardCamera(390, 844, 1704, 480);
    expect(overview.scale).toBeLessThan(0.3);
    expect(open).toEqual(overview);
    const desk = initialBoardCamera(1520, 800, 1704, 480);
    expect(desk).toEqual(fitBoardCamera(1520, 800, 1704, 480));
  });

  test("duplicate workspace names keep a cwd tail", () => {
    const spaces = [
      { id: "w1", label: "pairfob" },
      { id: "w2", label: "pairfob" },
    ];
    const cards: AgentCard[] = [
      { ...agents[0], workspaceId: "w1", workspaceLabel: "pairfob", cwd: "/Users/me/projects/test/pairfob" },
      { ...agents[1], workspaceId: "w2", workspaceLabel: "pairfob", cwd: "/Users/me/projects/github/pairfob" },
    ];
    expect(workspaceChipLabel(spaces[0], spaces, cards, "unnamed")).toBe("pairfob · test/pairfob");
    expect(workspaceChipLabel(spaces[1], spaces, cards, "unnamed")).toBe("pairfob · github/pairfob");
  });

  test("identical pane titles on one tab get an ordinal", () => {
    expect(
      numberDuplicateTitles([
        { id: "p1", title: "终端", cwd: "/tmp/a" },
        { id: "p2", title: "终端", cwd: "/tmp/a" },
        { id: "p3", title: "codex", cwd: "/tmp/a" },
      ]),
    ).toEqual({ p1: "终端", p2: "终端 · 2", p3: "codex" });
  });
});
