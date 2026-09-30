import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint, StatusMark } from "../../../lib/herd-attention";
import { setLang, t } from "../../../lib/i18n";
import { PINNED_GROUP_ID } from "../../../lib/ranking";
import {
  blockedElsewhere,
  buildHerdViewModel,
  herdAgo,
  herdCardClassName,
  herdCardPill,
  herdDoneCount,
  paneHeaderLine,
  paneIdentity,
  type HerdModelInput,
} from "./herd-view";

function agent(
  id: string,
  workspace: string,
  status: DashboardAgentCard["status"] = "idle",
  extra: Partial<DashboardAgentCard> = {},
): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: workspace, workspaceLabel: workspace, cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab`,
    ...extra,
  };
}

function attention(marks: Record<string, StatusMark> = {}, dismissing: string[] = [], stagger = false): HerdPaint {
  return {
    stagger,
    markOf: (paneId) => marks[paneId] ?? "",
    isDismissing: (paneId) => dismissing.includes(paneId),
    completed: [],
  };
}

function input(overrides: Partial<HerdModelInput> = {}): HerdModelInput {
  return {
    agents: [],
    listGroup: "flat",
    paneTouched: {},
    paneActivated: {},
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "",
    attention: attention(),
    liveness: "live",
    status: { tone: "live", text: "connected" },
    reading: false,
    snapshotLoaded: true,
    recentDirs: [],
    connected: true,
    networkOnline: true,
    runtimeKind: "herdr",
    createConversation: false,
    operationBusy: false,
    computerCount: 1,
    morphingPaneId: null,
    host: { name: "studio", line: "connected", tone: "live" },
    createTab: true,
    now: 60 * 60_000,
    ...overrides,
  };
}

beforeEach(() => setLang("zh"));

describe("herd card projection", () => {
  test("status, selection, pin and attention each add their own class", () => {
    expect(herdCardClassName({ status: "working", stale: false, selected: false, pinned: false, mark: "", dismissing: false }))
      .toBe("card status-working");
    expect(herdCardClassName({ status: "done", stale: false, selected: true, pinned: true, mark: "", dismissing: false }))
      .toBe("card status-done sel pinned");
    expect(herdCardClassName({ status: "done", stale: false, selected: false, pinned: false, mark: "done", dismissing: false }))
      .toBe("card status-done ac-changed ac-done");
    expect(herdCardClassName({ status: "working", stale: false, selected: false, pinned: false, mark: "changed", dismissing: true }))
      .toBe("card status-working ac-changed attn-out");
    expect(herdCardClassName({ status: "idle", stale: true, selected: false, pinned: false, mark: "", dismissing: false }))
      .toBe("card status-idle unverifiable");
  });

  test("loss of contact replaces the pill but keeps the card's own status class", () => {
    expect(herdCardPill("done", false)).toEqual({ className: "pill pill-done", text: t("status.done") });
    expect(herdCardPill("done", true)).toEqual({ className: "pill pill-unknown", text: t("status.unverifiable") });
  });

  test("the completion count only counts cards still reporting done", () => {
    expect(herdDoneCount([agent("p1", "a", "done"), agent("p2", "a", "working"), agent("p3", "a", "done")])).toBe(2);
    expect(herdDoneCount([])).toBe(0);
  });
});

describe("herd list projection", () => {
  test("flat mode renders one section and numbers rows for the entrance stagger", () => {
    const view = buildHerdViewModel(input({ agents: [agent("p1", "alpha"), agent("p2", "beta")] }));
    expect(view.grouped).toBe(false);
    expect(view.groups.map((group) => [group.id, group.index, group.count])).toEqual([["all", 0, 2]]);
    expect(view.groupIds).toEqual(["all"]);
    expect(view.groups[0].cards.map((card) => card.index)).toEqual([1, 2]);
    expect(view.groups[0].cards.map((card) => card.paneId)).toEqual(["p1", "p2"]);
  });

  test("pinned panes lead, then recency, then workspace groups keep their own order", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha"), agent("p2", "beta"), agent("p3", "gamma")],
      listGroup: "space",
      panePinned: { p3: 1 },
      paneTouched: { p1: 30, p2: 20 },
    }));
    expect(view.grouped).toBe(true);
    expect(view.groups.map((group) => group.title)).toEqual([t("group.pinned"), "alpha", "beta"]);
    expect(view.groups.map((group) => group.index)).toEqual([0, 2, 4]);
    expect(view.groupIds).toEqual([PINNED_GROUP_ID, "alpha", "beta"]);
    expect(view.groups[0].cards[0].paneId).toBe("p3");
    expect(view.groups[0].cards[0].pinned).toBe(true);
    expect(view.groups[0].cards[0].pinnedLabel).toBe(t("home.pinned"));
  });

  test("only a workspace group with a real workspace id owns the heading menu", () => {
    const grouped = buildHerdViewModel(input({
      agents: [agent("p1", "alpha"), agent("p2", "beta")],
      listGroup: "space",
      panePinned: { p2: 1 },
    }));
    expect(grouped.groups.map((group) => [group.id, group.hasMenu])).toEqual([
      [PINNED_GROUP_ID, false],
      ["alpha", true],
    ]);
    expect(grouped.groups[1].menuAgent?.paneId).toBe("p1");
    const flat = buildHerdViewModel(input({ agents: [agent("p1", "alpha")], listGroup: "flat" }));
    expect(flat.groups[0].hasMenu).toBe(false);
    const nameless = buildHerdViewModel(input({
      agents: [agent("p1", "", "idle", { workspaceId: "", workspaceLabel: "" })],
      listGroup: "space",
    }));
    expect(nameless.groups[0].hasMenu).toBe(false);
  });

  test("the accordion reads the projected collapse map and never invents one", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha"), agent("p2", "beta"), agent("p3", "gamma")],
      listGroup: "space",
      groupCollapsed: { alpha: false, beta: true },
    }));
    expect(view.groups.map((group) => [group.id, group.collapsed])).toEqual([
      ["alpha", false],
      ["beta", true],
      ["gamma", false],
    ]);
    const flat = buildHerdViewModel(input({ agents: [agent("p1", "alpha")], groupCollapsed: { all: true } }));
    expect(flat.groups[0].collapsed).toBe(false);
  });

  test("selection, transition sharing and attention marks follow the pane identity", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha", "working"), agent("p2", "alpha", "done")],
      selectedPaneId: "p2",
      morphingPaneId: "p1",
      attention: attention({ p2: "done" }, ["p1"], true),
    }));
    const [first, second] = view.groups[0].cards;
    expect(first.selected).toBe(false);
    expect(first.sharesTransition).toBe(true);
    expect(first.className).toBe("card status-working attn-out");
    expect(second.selected).toBe(true);
    expect(second.sharesTransition).toBe(false);
    expect(second.className).toBe("card status-done sel ac-changed ac-done");
    expect(view.stagger).toBe(true);
  });

  test("unverifiable status does not claim fresh attention counts", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha", "done")],
      status: { tone: "warn", text: t("chrome.unverifiable") },
      liveness: "unverifiable",
      connected: false,
    }));
    expect(view.status).toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(view.doneCount).toBe(0);
    expect(view.pendingCount).toBe(0);
    expect(view.groups[0].cards[0].className).toContain("unverifiable");
  });
});

describe("herd chrome gates", () => {
  test("create follows its capability, then busy and connection", () => {
    expect(buildHerdViewModel(input()).create).toBeNull();
    const advertised = buildHerdViewModel(input({ createConversation: true }));
    expect(advertised.create).toEqual({ label: t("home.new"), aria: t("home.newAria"), disabled: false });
    expect(buildHerdViewModel(input({ createConversation: true, operationBusy: true })).create)
      .toEqual({ label: t("home.creating"), aria: t("home.newAria"), disabled: true });
    expect(buildHerdViewModel(input({ createConversation: true, connected: false })).create?.disabled).toBe(true);
  });

  test("the computers link needs a second computer; board and settings are always there", () => {
    expect(buildHerdViewModel(input()).computers).toBeNull();
    expect(buildHerdViewModel(input({ computerCount: 2 })).computers).toEqual({ label: t("home.computers") });
    const view = buildHerdViewModel(input());
    expect(view.board).toEqual({ label: t("home.board"), current: false });
    expect(view.settings).toEqual({ label: t("home.settings") });
  });

  test("the board beside the rail makes its link current and marks its tab's rows", () => {
    const agents = [agent("w1:p1", "w1", "idle", { tabId: "w1:t1" }), agent("w1:p2", "w1", "idle", { tabId: "w1:t2" })];
    const view = buildHerdViewModel(input({ agents, boardOpen: true, boardTabId: "w1:t1" }));
    expect(view.board.current).toBeTrue();
    const cards = view.groups.flatMap((group) => group.cards);
    expect(cards.find((card) => card.paneId === "w1:p1")?.className).toContain(" in-board");
    expect(cards.find((card) => card.paneId === "w1:p2")?.className).not.toContain("in-board");
    // Without the board on screen no row is marked, whatever tab the board last showed.
    const closed = buildHerdViewModel(input({ agents, boardOpen: false, boardTabId: "w1:t1" }));
    expect(closed.groups.flatMap((group) => group.cards).some((card) => card.className.includes("in-board"))).toBeFalse();
  });

  test("an empty herd explains itself and gates its action on busy state", () => {
    const view = buildHerdViewModel(input({ createConversation: true, recentDirs: ["a", "b", "c", "d"] }));
    expect(view.empty?.kind).toBe("none");
    expect(view.empty?.title).toBe(t("empty.hostTitle", { host: "studio" }));
    expect(view.empty?.actions.map((action) => action.kind)).toEqual(["create"]);
    expect(view.empty?.actions[0].disabled).toBe(false);
    expect(view.empty?.recentDirs).toEqual(["a", "b", "c"]);
    expect(buildHerdViewModel(input({ createConversation: true, operationBusy: true })).empty?.actions[0].disabled).toBe(true);
    expect(buildHerdViewModel(input({ agents: [agent("p1", "alpha")] })).empty).toBeNull();
    // A computer that does not allow starting sessions gets the command instead of a button.
    const closed = buildHerdViewModel(input({ createConversation: false })).empty;
    expect(closed?.kind).toBe("noCreate");
    expect(closed?.actions).toEqual([]);
    expect(closed?.command).toBe("herdr");
    // Offline or reconnecting: the header already says so; no button repeats it.
    expect(buildHerdViewModel(input({ networkOnline: false })).empty?.kind).toBe("offline");
    expect(buildHerdViewModel(input({ connected: false })).empty?.actions).toEqual([]);
  });
});

describe("phone list projection", () => {
  test("a terminal names no status and never needs the reader; an agent does", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("wait", "alpha", "blocked"), agent("sh", "alpha", "blocked", { agent: "", hasAgent: false })],
    }));
    const card = (id: string) => view.groups[0].cards.find((item) => item.paneId === id)!;
    const wait = card("wait");
    const sh = card("sh");
    expect(wait.kind).toBe("agent");
    expect(wait.statusLabel).toBe(t("status.blocked"));
    expect(wait.blocked).toBe(true);
    expect(sh.kind).toBe("terminal");
    expect(sh.statusLabel).toBe("");
    expect(sh.blocked).toBe(false);
    expect(view.attention.map((item) => item.paneId)).toEqual(["wait"]);
    expect(view.pendingCount).toBe(1);
  });

  test("the needs-you list puts waiting first, then the newest unread completions", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("old", "a", "done"), agent("new", "a", "done"), agent("wait", "b", "blocked")],
      paneTouched: { old: 1, new: 5, wait: 2 },
    }));
    expect(view.attention.map((item) => `${item.kind}:${item.paneId}`)).toEqual(["blocked:wait", "done:new", "done:old"]);
    expect(view.doneCount).toBe(2);
  });

  test("workspace groups carry the root path, marks and the create-tab gate", () => {
    const agents = [
      agent("p1", "alpha", "blocked", { workspaceCwd: "/work/alpha" }),
      agent("p2", "alpha", "done", { workspaceCwd: "/work/alpha" }),
      agent("p3", "beta", "idle", { workspaceCwd: "/work/beta" }),
    ];
    const view = buildHerdViewModel(input({ agents, listGroup: "space" }));
    expect(view.groups.map((group) => [group.id, group.path, group.blockedCount, group.doneCount, group.canCreateTab]))
      .toEqual([["alpha", "/work/alpha", 1, 1, true], ["beta", "/work/beta", 0, 0, true]]);
    const gated = buildHerdViewModel(input({ agents, listGroup: "space", createTab: false }));
    expect(gated.groups.every((group) => !group.canCreateTab)).toBe(true);
  });

  test("while stale nothing is reported as waiting or unread", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("wait", "alpha", "blocked"), agent("done", "alpha", "done")],
      liveness: "unverifiable",
    }));
    expect(view.attention).toEqual([]);
    expect(view.groups[0].cards.map((item) => [item.statusLabel, item.statusTone, item.blocked, item.unread]))
      .toEqual([[t("status.unverifiable"), "unknown", false, false], [t("status.unverifiable"), "unknown", false, false]]);
  });

  test("the host title and the change time come straight from the input", () => {
    const view = buildHerdViewModel(input({ agents: [agent("p1", "alpha")], paneTouched: { p1: 58 * 60_000 } }));
    expect(view.host).toEqual({ name: "studio", line: "connected", tone: "live" });
    expect(view.groups[0].cards[0].ago).toBe(t("list.agoMin", { n: "2" }));
  });

  test("change times read now, minutes, hours and days, and nothing when unseen", () => {
    const now = 10 * 86_400_000;
    expect(herdAgo(undefined, now)).toBe("");
    expect(herdAgo(now - 20_000, now)).toBe(t("list.agoNow"));
    expect(herdAgo(now - 5 * 60_000, now)).toBe(t("list.agoMin", { n: "5" }));
    expect(herdAgo(now - 3 * 3_600_000, now)).toBe(t("list.agoHour", { n: "3" }));
    expect(herdAgo(now - 2 * 86_400_000, now)).toBe(t("list.agoDay", { n: "2" }));
  });

  test("rows and workspaces follow the reader's last open; a status change moves nothing", () => {
    const agents = [agent("a1", "alpha"), agent("a2", "alpha"), agent("b1", "beta"), agent("b2", "beta")];
    const order = (view: ReturnType<typeof buildHerdViewModel>) =>
      view.groups.map((group) => `${group.id}:${group.cards.map((card) => card.paneId).join(",")}`);
    // Nothing opened: the computer's order.
    expect(order(buildHerdViewModel(input({ agents, listGroup: "space" }))))
      .toEqual(["alpha:a1,a2", "beta:b1,b2"]);
    // b2 changed status most recently, but the reader opened a2 last.
    const view = buildHerdViewModel(input({ agents, listGroup: "space", paneTouched: { b2: 90 }, paneActivated: { a2: 10, b1: 5 } }));
    expect(order(view)).toEqual(["alpha:a2,a1", "beta:b1,b2"]);
    const later = buildHerdViewModel(input({ agents, listGroup: "space", paneActivated: { a2: 10, b2: 20 } }));
    expect(order(later)).toEqual(["beta:b2,b1", "alpha:a2,a1"]);
  });
});

describe("pane identity shared by the list card and the session header", () => {
  beforeEach(() => setLang("zh"));

  test("the card renders exactly the shared identity", () => {
    const row = agent("fix login", "pairfob", "working");
    const card = buildHerdViewModel(input({ agents: [row], listGroup: "space" })).groups[0]!.cards[0]!;
    const identity = paneIdentity(row, "space", false);
    expect([card.title, card.statusLabel, card.statusTone, card.line, card.meta, card.kind, card.agentKind])
      .toEqual([identity.title, identity.statusLabel, identity.statusTone, identity.line, identity.meta, identity.kind, identity.agentKind]);
  });

  test("a plain terminal has no status word, and lost contact reads as unknown", () => {
    expect(paneIdentity(agent("t", "w", "working", { agent: "", hasAgent: false }), "flat", false).statusLabel).toBe("");
    const stale = paneIdentity(agent("a", "w", "working"), "flat", true);
    expect([stale.statusLabel, stale.statusTone]).toEqual([t("status.unverifiable"), "unknown"]);
  });

  test("the header names the workspace the group heading would have, unless it is already shown", () => {
    const row = agent("fix login", "pairfob", "working", { cwd: "/src/pairfob" });
    // Grouped by workspace, the card line leaves the workspace to the heading.
    const grouped = paneIdentity(row, "space", false);
    expect(grouped.line.split(" · ")).not.toContain("pairfob");
    expect(paneHeaderLine(grouped, row)).toBe(`${grouped.line} · pairfob`);
    // Flat, the line already carries it; the header does not repeat it.
    const flat = paneIdentity(row, "flat", false);
    expect(paneHeaderLine(flat, row)).toBe(flat.line);
    // Nor when the title already is the workspace.
    expect(paneHeaderLine({ ...grouped, title: "pairfob", line: "codex" }, row)).toBe("codex");
  });

  test("the back badge counts other agents waiting on the reader and nothing while unverifiable", () => {
    const rows = [
      agent("p1", "w", "blocked"),
      agent("p2", "w", "blocked"),
      agent("p3", "w", "blocked", { agent: "", hasAgent: false }),
      agent("p4", "w", "working"),
    ];
    expect(blockedElsewhere(rows, "p1", false)).toBe(1);
    expect(blockedElsewhere(rows, "p4", false)).toBe(2);
    expect(blockedElsewhere(rows, "p4", true)).toBe(0);
  });
});

describe("before the first read answers", () => {
  test("nothing read yet shows placeholder rows, never an empty-state claim", () => {
    const view = buildHerdViewModel(input({ snapshotLoaded: false }));
    expect(view.loading).toBe(true);
    expect(view.empty).toBeNull();
    // The runtime still being read: loading even if an empty snapshot came first.
    const reading = buildHerdViewModel(input({ liveness: "unverifiable", runtimeKind: "", reading: true }));
    expect(reading.loading).toBe(true);
    expect(reading.empty).toBeNull();
  });

  test("an answered empty list, or a runtime that failed, keeps its explanation", () => {
    expect(buildHerdViewModel(input()).empty?.kind).toBe("noCreate");
    const failed = buildHerdViewModel(input({ liveness: "unverifiable", runtimeKind: "", snapshotLoaded: false }));
    expect(failed.loading).toBe(false);
    expect(failed.empty?.kind).toBe("unverifiable");
    expect(failed.empty?.actions.map((action) => action.kind)).toEqual(["retry", "details"]);
    const offline = buildHerdViewModel(input({ networkOnline: false, snapshotLoaded: false }));
    expect(offline.loading).toBe(false);
  });

  test("rows that arrive while the runtime is still being read are fresh, not stale", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha", "blocked")], liveness: "unverifiable", runtimeKind: "", reading: true,
    }));
    expect(view.groups[0].cards[0].className).not.toContain("unverifiable");
    expect(view.attention).toHaveLength(1);
    const stale = buildHerdViewModel(input({ agents: [agent("p1", "alpha", "blocked")], liveness: "unverifiable", runtimeKind: "" }));
    expect(stale.groups[0].cards[0].className).toContain("unverifiable");
  });
});
