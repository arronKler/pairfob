import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import { buildHerdViewModel, type HerdModelInput } from "../../dashboard/model/herd-view";
import { activeItem, attentionSessions, buildPalette, paletteActions, stepActive, waitingSessions, type PaletteInput, type PaletteItem } from "./palette";

function agent(id: string, status: DashboardAgentCard["status"] = "idle", extra: Partial<DashboardAgentCard> = {}): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: "pairfob", workspaceLabel: "pairfob", workspaceCwd: "/work/pairfob", cwd: "/work/pairfob",
    tabId: "pairfob:tab", tabLabel: "implementation",
    ...extra,
  };
}

function herd(agents: DashboardAgentCard[], overrides: Partial<HerdModelInput> = {}): HerdModelInput {
  return {
    agents,
    listGroup: "flat",
    paneTouched: {},
    paneActivated: {},
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "",
    attention: { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] },
    liveness: "live",
    status: { tone: "live", text: "connected" },
    reading: false,
    snapshotLoaded: true,
    recentDirs: [],
    connected: true,
    networkOnline: true,
    runtimeKind: "herdr",
    createConversation: true,
    operationBusy: false,
    computerCount: 1,
    morphingPaneId: null,
    host: { name: "studio", line: "connected", tone: "live" },
    createTab: true,
    now: 60 * 60_000,
    ...overrides,
  };
}

function input(agents: DashboardAgentCard[], extra: Partial<Omit<PaletteInput, "view">> = {}, overrides: Partial<HerdModelInput> = {}): PaletteInput {
  return { view: buildHerdViewModel(herd(agents, overrides)), activated: {}, currentPaneId: "", ...extra };
}

function titles(items: readonly PaletteItem[]): string[] {
  return items.map((item) => item.type === "session" ? item.title : item.label);
}

beforeEach(() => setLang("zh"));

describe("palette with nothing typed", () => {
  test("waiting sessions lead, then the sessions opened last, then the actions", () => {
    const palette = buildPalette(input(
      [agent("old"), agent("ask", "blocked"), agent("new", "working"), agent("never")],
      { activated: { old: 10, new: 20 } },
    ), "");
    expect(palette.sections.map((section) => section.id)).toEqual(["waiting", "recent", "actions"]);
    expect(palette.sections[0].title).toBe(t("palette.waiting", { count: "1" }));
    expect(titles(palette.sections[0].items)).toEqual(["ask"]);
    // Never opened from this device: not recent, still reachable by typing.
    expect(titles(palette.sections[1].items)).toEqual(["new", "old"]);
    // Enter on a fresh palette goes to the next waiting session.
    expect(activeItem(palette.items, null)).toMatchObject({ type: "session", paneId: "ask" });
  });

  test("a row carries what the list row shows, and nothing read from a pane", () => {
    const [row] = buildPalette(input([agent("ask", "blocked")]), "").items;
    expect(row).toEqual({
      type: "session", key: "session:ask", paneId: "ask", kind: "agent", agentKind: "codex", title: "ask",
      statusLabel: t("status.blocked"), statusTone: "blocked", meta: "codex · pairfob · implementation", waiting: true,
    });
  });

  test("a finished session is recent, not waiting: opening it would mark it read", () => {
    const source = input([agent("fin", "done"), agent("ask", "blocked")], { activated: { fin: 5 } });
    expect(waitingSessions(source).map((session) => session.paneId)).toEqual(["ask"]);
    // The "needs you" strip's own set and order keeps it, behind the waiting one.
    expect(attentionSessions(source).map((session) => [session.paneId, session.waiting])).toEqual([["ask", true], ["fin", false]]);
    expect(buildPalette(source, "").sections.map((section) => [section.id, titles(section.items)]).slice(0, 2))
      .toEqual([["waiting", ["ask"]], ["recent", ["fin"]]]);
  });

  test("the session on screen is left out of recent, so Enter leads somewhere else", () => {
    const palette = buildPalette(input([agent("here"), agent("before")], { activated: { here: 20, before: 10 }, currentPaneId: "here" }), "");
    expect(titles(palette.sections[0].items)).toEqual(["before"]);
  });

  test("with no opens on record the top of the list stands in, under a heading that claims no history", () => {
    const palette = buildPalette(input([agent("a"), agent("b")]), "");
    expect(palette.sections[0]).toMatchObject({ id: "sessions", title: t("palette.sessions") });
    expect(titles(palette.sections[0].items)).toEqual(["a", "b"]);
  });

  test("recent stops at five rows", () => {
    const agents = ["a", "b", "c", "d", "e", "f", "g"].map((id) => agent(id));
    const activated = Object.fromEntries(agents.map((item, index) => [item.paneId, index + 1]));
    expect(titles(buildPalette(input(agents, { activated }), "").sections[0].items)).toEqual(["g", "f", "e", "d", "c"]);
  });

  test("nothing waits while the computer cannot be confirmed", () => {
    const source = input([agent("ask", "blocked")], {}, { liveness: "unverifiable" });
    expect(waitingSessions(source)).toEqual([]);
    expect(attentionSessions(source)).toEqual([]);
    expect(buildPalette(source, "").sections.map((section) => section.id)).toEqual(["sessions", "actions"]);
  });
});

describe("palette actions", () => {
  test("they follow the rail: create is absent without the capability and disabled while it cannot run", () => {
    expect(paletteActions(input([]).view).map((item) => [item.action, item.disabled]))
      .toEqual([["create", false], ["board", false], ["computers", false], ["settings", false]]);
    expect(paletteActions(input([], {}, { createConversation: false }).view).map((item) => item.action))
      .toEqual(["board", "computers", "settings"]);
    expect(paletteActions(input([], {}, { operationBusy: true }).view)[0]).toMatchObject({ action: "create", disabled: true });
    // The list's own answer to "can a session be started now", which the rail's + and the main column read too:
    // not while the connection is down, Herdr is not running or did not answer, or the list is still being read.
    for (const cannot of [
      { connected: false, liveness: "unverifiable" }, { runtimeKind: "offline", liveness: "exited" },
      { runtimeKind: "", liveness: "unverifiable" }, { snapshotLoaded: false },
    ] satisfies Partial<HerdModelInput>[]) {
      expect(paletteActions(input([], {}, cannot).view)[0]).toMatchObject({ action: "create", disabled: true });
    }
  });

  test("the board is not offered while it is the page beside the list", () => {
    expect(paletteActions(input([], {}, { boardOpen: true }).view).map((item) => item.action))
      .toEqual(["create", "computers", "settings"]);
  });
});

describe("palette query", () => {
  const agents = [
    agent("Fix flaky review test", "working", { workspaceId: "dash", workspaceLabel: "dashboard", workspaceCwd: "/work/dashboard", cwd: "/work/dashboard", tabLabel: "api" }),
    agent("Review swipe gestures", "blocked"),
    agent("Validate types", "done", { agent: "grok", tabLabel: "review" }),
    agent("Reviewer notes", "idle", { agent: "claude" }),
    agent("Preview deploy", "idle", { agent: "claude" }),
  ];

  test("waiting sessions rank first, then a name that starts with the query, then a word or field that does, then a mere mention", () => {
    const palette = buildPalette(input(agents), "review");
    expect(palette.sections.map((section) => section.id)).toEqual(["sessions"]);
    expect(titles(palette.items)).toEqual([
      "Review swipe gestures", "Reviewer notes", "Fix flaky review test", "Validate types", "Preview deploy",
    ]);
  });

  test("a session answers to its agent, its workspace name and path, and its tab", () => {
    expect(titles(buildPalette(input(agents), "grok").items)).toEqual(["Validate types"]);
    expect(titles(buildPalette(input(agents), "dashb").items)).toEqual(["Fix flaky review test"]);
    expect(titles(buildPalette(input(agents), "/work/dash").items)).toEqual(["Fix flaky review test"]);
    expect(titles(buildPalette(input(agents), "api").items)).toEqual(["Fix flaky review test"]);
  });

  test("case and stray spaces do not matter, and every typed word has to appear", () => {
    expect(titles(buildPalette(input(agents), "  REVIEW   swipe ").items)).toEqual(["Review swipe gestures"]);
    expect(titles(buildPalette(input(agents), "types grok").items)).toEqual(["Validate types"]);
    expect(buildPalette(input(agents), "types cursor").items).toEqual([]);
  });

  test("equal matches keep the order of the reader's last opens", () => {
    const pair = [agent("review a"), agent("review b")];
    expect(titles(buildPalette(input(pair, { activated: { "review b": 9 } }), "review").items)).toEqual(["review b", "review a"]);
  });

  test("actions are found by their label and by a plain English word", () => {
    const actions = (query: string) => titles(buildPalette(input(agents), query).sections.find((section) => section.id === "actions")?.items ?? []);
    expect(actions("设置")).toEqual([t("palette.settings")]);
    expect(actions("board")).toEqual([t("palette.board")]);
    expect(actions("new")).toEqual([t("palette.create")]);
    expect(actions("review")).toEqual([]);
  });

  test("no match leaves nothing to act on", () => {
    const palette = buildPalette(input(agents), "zzz");
    expect(palette.sections).toEqual([]);
    expect(activeItem(palette.items, null)).toBeNull();
    expect(stepActive(palette.items, null, 1)).toBeNull();
  });
});

describe("palette highlight", () => {
  test("the arrows walk every runnable item and wrap; a disabled action is skipped", () => {
    const palette = buildPalette(input([agent("a")], {}, { operationBusy: true }), "");
    expect(palette.items.map((item) => item.key)).toEqual(["session:a", "action:create", "action:board", "action:computers", "action:settings"]);
    expect(stepActive(palette.items, null, 1)).toBe("action:board");
    expect(stepActive(palette.items, "action:board", -1)).toBe("session:a");
    expect(stepActive(palette.items, null, -1)).toBe("action:settings");
    expect(stepActive(palette.items, "action:settings", 1)).toBe("session:a");
    expect(activeItem(palette.items, "action:create")?.key).toBe("session:a");
  });

  test("a highlight whose row left the list falls back to the first", () => {
    const palette = buildPalette(input([agent("a"), agent("b")]), "");
    expect(activeItem(palette.items, "session:b")?.key).toBe("session:b");
    expect(activeItem(palette.items, "session:gone")?.key).toBe("session:a");
  });
});
