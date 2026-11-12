import { describe, expect, test } from "bun:test";
import { mapSnapshotAgents } from "../../../lib/dashboard";
import { peekPlacement, rulerView } from "./session-ruler-model";

function agents(panes: Array<{ id: string; workspace?: string; status?: string; label?: string }>) {
  return mapSnapshotAgents({
    workspaces: [
      { workspace_id: "w1", label: "one" },
      { workspace_id: "w2", label: "two" },
    ],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "main" },
      { tab_id: "t2", workspace_id: "w2", label: "main" },
    ],
    panes: panes.map(({ id, workspace = "w1", status = "idle", label = id }) => ({
      pane_id: id, workspace_id: workspace, tab_id: workspace === "w2" ? "t2" : "t1",
      agent: "codex", agent_status: status, label, cwd: "/repo",
    })),
  });
}

describe("rulerView", () => {
  test("flattens the list's groups in their order, pinned rows first", () => {
    const view = rulerView({
      agents: agents([{ id: "p1" }, { id: "p2" }, { id: "p3" }]),
      listGroup: "flat",
      activation: {},
      pinned: { p3: 1 },
      currentPaneId: "p1",
      stale: false,
    });
    expect(view.ticks.map((tick) => tick.paneId)).toEqual(["p3", "p1", "p2"]);
    expect(view.currentIndex).toBe(1);
    expect(view.ticks[1]!.current).toBeTrue();
    expect(view.visible).toBeTrue();
  });

  test("groups follow the activation the list was drawn by", () => {
    const view = rulerView({
      agents: agents([{ id: "p1", workspace: "w1" }, { id: "p2", workspace: "w2" }]),
      listGroup: "space",
      activation: { p2: 9 },
      pinned: {},
      currentPaneId: "p1",
      stale: false,
    });
    expect(view.ticks.map((tick) => tick.paneId)).toEqual(["p2", "p1"]);
  });

  test("the preview names the group only when the line does not already say it", () => {
    const space = rulerView({
      agents: agents([{ id: "p1" }]),
      listGroup: "space",
      activation: {},
      pinned: {},
      currentPaneId: "p1",
      stale: false,
    });
    expect(space.ticks[0]!.line).toContain("one");
    expect(space.ticks[0]!.group).toBe("");

    const byAgent = rulerView({
      agents: agents([{ id: "p1" }]),
      listGroup: "agent",
      activation: {},
      pinned: {},
      currentPaneId: "p1",
      stale: false,
    });
    expect(byAgent.ticks[0]!.group).toBe("codex");
  });

  test("stale status gates the warn tick and the status word", () => {
    const view = rulerView({
      agents: agents([{ id: "p1" }, { id: "p2", status: "blocked" }]),
      listGroup: "flat",
      activation: {},
      pinned: {},
      currentPaneId: "p1",
      stale: true,
    });
    expect(view.ticks[1]!.blocked).toBeFalse();
    expect(view.ticks[1]!.statusLabel).not.toBe("blocked");
  });

  test("a plain terminal is never blocked, whatever the wire says", () => {
    const [terminal] = agents([{ id: "term" }]);
    const view = rulerView({
      agents: [{ ...terminal!, agent: "", hasAgent: false, status: "blocked" }],
      listGroup: "flat",
      activation: {},
      pinned: {},
      currentPaneId: "term",
      stale: false,
    });
    expect(view.ticks[0]!.kind).toBe("terminal");
    expect(view.ticks[0]!.blocked).toBeFalse();
  });

  test("is hidden under two rows, or when the open pane is not in the list", () => {
    const one = rulerView({
      agents: agents([{ id: "p1" }]),
      listGroup: "flat",
      activation: {},
      pinned: {},
      currentPaneId: "p1",
      stale: false,
    });
    expect(one.visible).toBeFalse();

    const elsewhere = rulerView({
      agents: agents([{ id: "p1" }, { id: "p2" }]),
      listGroup: "flat",
      activation: {},
      pinned: {},
      currentPaneId: "gone",
      stale: false,
    });
    expect(elsewhere.currentIndex).toBe(-1);
    expect(elsewhere.visible).toBeFalse();
  });
});

describe("peekPlacement", () => {
  const anchor = { bottom: 52 };
  const viewport = { width: 390, height: 844 };

  test("centres the card on its tick and keeps it off the edges", () => {
    expect(peekPlacement(anchor, viewport, 195)).toEqual({ left: 34, top: 60, width: 322 });
    expect(peekPlacement(anchor, viewport, 4).left).toBe(8);
    expect(peekPlacement(anchor, viewport, 386).left).toBe(60);
  });

  test("narrow viewports keep the 8px gutter on both sides", () => {
    const narrow = peekPlacement(anchor, { width: 300, height: 600 }, 150);
    expect(narrow.width).toBe(284);
    expect(narrow.left).toBe(8);
  });
});
