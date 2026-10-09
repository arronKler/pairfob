import { describe, expect, test } from "bun:test";
import {
  groupAgents,
  holdActivation,
  nextTouchedAt,
  paneIsPinned,
  parseListGroup,
  parsePinnedAt,
  PINNED_GROUP_ID,
  prunePinnedAt,
  rankAgents,
  syncGroupCollapsed,
  toggleGroupCollapsed,
  togglePinnedAt,
  touchPane,
  type AgentCard,
} from "./ranking";

const sample: AgentCard[] = [
  { paneId: "b", agent: "codex", status: "idle", workspaceId: "w-x", workspaceLabel: "Relay", cwd: "/" },
  { paneId: "a", agent: "claude", status: "blocked", workspaceId: "w-k", workspaceLabel: "Pairfob", cwd: "/" },
  { paneId: "c", agent: "claude", status: "working", workspaceId: "w-k", workspaceLabel: "Pairfob", cwd: "/" },
  { paneId: "d", agent: "", status: "idle", workspaceId: "w-x", workspaceLabel: "Relay", cwd: "/" },
];

describe("rankAgents", () => {
  test("orders by latest operation, not status", () => {
    const r = rankAgents(sample, { c: 30, a: 20, b: 10 });
    expect(r.map((item) => item.paneId)).toEqual(["c", "a", "b", "d"]);
  });

  test("keeps the computer's order when nothing has been opened", () => {
    expect(rankAgents(sample).map((item) => item.paneId)).toEqual(["b", "a", "c", "d"]);
  });

  test("pinned sessions sit above recency and keep recency among themselves", () => {
    const r = rankAgents(sample, { d: 40, c: 30, a: 20, b: 10 }, { a: 9, d: 1 });
    expect(r.map((item) => item.paneId)).toEqual(["d", "a", "c", "b"]);
  });
});

describe("pane pins", () => {
  test("parsePinnedAt keeps finite positive stamps", () => {
    expect(parsePinnedAt({ a: 3, b: 0, c: -1, d: "8", "": 9, e: Number.NaN })).toEqual({ a: 3 });
    expect(parsePinnedAt(null)).toEqual({});
    expect(parsePinnedAt(["a"])).toEqual({});
  });

  test("toggle pins and unpins a pane", () => {
    const pinned = togglePinnedAt({}, "a", 11);
    expect(paneIsPinned(pinned, "a")).toBe(true);
    expect(pinned.a).toBe(11);
    expect(togglePinnedAt(pinned, "a", 12)).toEqual({});
    expect(togglePinnedAt(pinned, "")).toBe(pinned);
  });

  test("prune drops panes that left the snapshot and keeps the same object when unchanged", () => {
    const current = { a: 1, b: 2 };
    expect(prunePinnedAt(current, ["a"])).toEqual({ a: 1 });
    expect(prunePinnedAt(current, ["a", "b"])).toBe(current);
  });
});

describe("nextTouchedAt", () => {
  test("treats a newly created pane as the latest operation", () => {
    const created: AgentCard = { paneId: "e", agent: "grok", status: "idle", workspaceLabel: "New", cwd: "/" };
    const touched = nextTouchedAt(sample, [...sample, created], { a: 1, b: 1, c: 1, d: 1 }, 99);
    expect(touched.e).toBe(99);
    expect(touched.a).toBe(1);
  });

  test("treats working → done as the latest operation", () => {
    const next = sample.map((agent) => agent.paneId === "c" ? { ...agent, status: "done" as const } : agent);
    const touched = nextTouchedAt(sample, next, { a: 1, b: 1, c: 1, d: 1 }, 50);
    expect(touched.c).toBe(50);
    expect(touched.a).toBe(1);
  });

  test("drops timestamps for panes that disappeared", () => {
    const touched = nextTouchedAt(sample, sample.filter((agent) => agent.paneId !== "b"), { a: 1, b: 8, c: 1, d: 1 }, 3);
    expect(touched.b).toBeUndefined();
  });
});

describe("touchPane", () => {
  test("records an explicit activation", () => {
    expect(touchPane({ a: 1 }, "b", 7)).toEqual({ a: 1, b: 7 });
  });
});

describe("groupAgents", () => {
  test("flat lists every session in recency order", () => {
    const groups = groupAgents(sample, "flat", { d: 4, b: 3, a: 2, c: 1 });
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("会话");
    expect(groups[0].items.map((item) => item.paneId)).toEqual(["d", "b", "a", "c"]);
  });

  test("space groups follow the pane the reader opened last, ties keep the computer's order", () => {
    const groups = groupAgents(sample, "space", { b: 20, a: 10, c: 9, d: 1 });
    expect(groups.map((group) => group.title)).toEqual(["Relay", "Pairfob"]);
    expect(groups[0].items.map((item) => item.paneId)).toEqual(["b", "d"]);
    expect(groups[1].items.map((item) => item.paneId)).toEqual(["a", "c"]);
    // Opening c lifts it to the top of its workspace and lifts that workspace.
    const opened = groupAgents(sample, "space", { b: 20, c: 99 });
    expect(opened.map((group) => group.id)).toEqual(["w-k", "w-x"]);
    expect(opened[0].items.map((item) => item.paneId)).toEqual(["c", "a"]);
    // Nothing opened yet: the computer's own order.
    expect(groupAgents(sample, "space", {}).map((group) => group.id)).toEqual(["w-x", "w-k"]);
  });

  test("agent groups by type and parks unbound panes together", () => {
    const groups = groupAgents(sample, "agent", { a: 3, c: 2, b: 1, d: 1 });
    expect(groups.map((group) => group.title)).toEqual(["claude", "codex", "未绑定 Agent"]);
    expect(groups[0].items.map((item) => item.paneId)).toEqual(["a", "c"]);
  });

  test("parseListGroup defaults to workspace grouping and keeps a stored choice", () => {
    expect(parseListGroup(null)).toBe("space");
    expect(parseListGroup("space")).toBe("space");
    expect(parseListGroup("agent")).toBe("agent");
    expect(parseListGroup("flat")).toBe("flat");
    expect(parseListGroup("needs")).toBe("space");
  });

  test("pinned sessions form a top section and leave their original groups", () => {
    const groups = groupAgents(sample, "space", { b: 20, a: 10, c: 9, d: 1 }, { a: 5, d: 6 });
    expect(groups.map((group) => group.id)).toEqual([PINNED_GROUP_ID, "w-x", "w-k"]);
    expect(groups[0].title).toBe("置顶");
    expect(groups[0].items.map((item) => item.paneId)).toEqual(["a", "d"]);
    expect(groups[1].items.map((item) => item.paneId)).toEqual(["b"]);
    expect(groups[2].items.map((item) => item.paneId)).toEqual(["c"]);
  });

  test("a fully pinned flat list is only the pinned section", () => {
    const groups = groupAgents(sample, "flat", {}, { a: 1, b: 1, c: 1, d: 1 });
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(PINNED_GROUP_ID);
    expect(groups[0].items).toHaveLength(4);
  });
});

describe("group collapse", () => {
  const groups = groupAgents(sample, "space", { b: 20, a: 10 });

  test("opens only the first group until the user toggles", () => {
    expect(syncGroupCollapsed(groups, {})).toEqual({ "w-x": false, "w-k": true });
  });

  test("keeps the first workspace open when a pinned section is present", () => {
    const pinned = groupAgents(sample, "space", { b: 20, a: 10 }, { a: 1 });
    expect(syncGroupCollapsed(pinned, {})).toEqual({
      [PINNED_GROUP_ID]: false,
      "w-x": false,
      "w-k": true,
    });
  });

  test("keeps a toggled group when the list reorders", () => {
    const openedSecond = toggleGroupCollapsed(groups, {}, "w-k");
    expect(openedSecond["w-k"]).toBe(false);
    const reordered = groupAgents(sample, "agent", { c: 40, b: 1 });
    expect(reordered.map((group) => group.id)).toEqual(["agent:claude", "agent:codex", "unbound"]);
    const toggled = toggleGroupCollapsed(reordered, {}, "agent:codex");
    const again = groupAgents(sample, "agent", { b: 50, c: 1 });
    expect(again.map((group) => group.id)).toEqual(["agent:codex", "agent:claude", "unbound"]);
    expect(syncGroupCollapsed(again, toggled)["agent:codex"]).toBe(false);
  });

  test("drops groups that disappeared and collapses a newly seen later group", () => {
    const current = { "w-x": false, gone: true };
    const next = groupAgents(sample, "agent", { a: 3, b: 2, d: 1 });
    expect(syncGroupCollapsed(next, current)).toEqual({
      "agent:claude": false,
      "agent:codex": true,
      unbound: true,
    });
  });
});

describe("held list order", () => {
  test("a list that stays on screen keeps the order it was built with", () => {
    const first = holdActivation(null, "mac", { a: 10, b: 20 }, ["a", "b", "c"]);
    expect(first.stamps).toEqual({ a: 10, b: 20 });
    // The reader opens `a` and then `c`: the live record moves, the held one does not.
    const later = holdActivation(first, "mac", { a: 30, b: 20, c: 40 }, ["a", "b", "c"]);
    expect(later).toBe(first);
    expect(rankAgents(sample.slice(0, 3), later.stamps).map((agent) => agent.paneId)).toEqual(["b", "a", "c"]);
  });

  test("a pane that turns up later joins with the stamp it has then, and keeps it", () => {
    const first = holdActivation(null, "mac", { a: 10 }, ["a"]);
    const joined = holdActivation(first, "mac", { a: 50, b: 60 }, ["a", "b", "c"]);
    expect(joined.stamps).toEqual({ a: 10, b: 60 });
    expect(holdActivation(joined, "mac", { a: 50, b: 70, c: 80 }, ["a", "b", "c"])).toBe(joined);
  });

  test("building the list again adopts the reader's latest opens", () => {
    const first = holdActivation(null, "mac\u0000flat", { a: 10 }, ["a", "b"]);
    const regrouped = holdActivation(first, "mac\u0000space", { a: 10, b: 90 }, ["a", "b"]);
    expect(regrouped.stamps).toEqual({ a: 10, b: 90 });
  });
});
