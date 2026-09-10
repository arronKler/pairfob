import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint, StatusMark } from "../../../lib/herd-attention";
import { setLang, t } from "../../../lib/i18n";
import { PINNED_GROUP_ID } from "../../../lib/ranking";
import {
  buildHerdViewModel,
  herdCardClassName,
  herdCardPill,
  herdDoneCount,
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
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "",
    attention: attention(),
    liveness: "live",
    status: { tone: "live", text: "connected" },
    connected: true,
    networkOnline: true,
    runtimeKind: "herdr",
    createConversation: false,
    operationBusy: false,
    computerCount: 1,
    morphingPaneId: null,
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

  test("the status line keeps its tone and the done count", () => {
    const view = buildHerdViewModel(input({
      agents: [agent("p1", "alpha", "done")],
      status: { tone: "warn", text: t("chrome.unverifiable") },
      liveness: "unverifiable",
      connected: false,
    }));
    expect(view.status).toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(view.doneCount).toBe(1);
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
    expect(view.board).toEqual({ label: t("home.board") });
    expect(view.settings).toEqual({ label: t("home.settings") });
  });

  test("an empty herd explains itself and gates its action on busy state", () => {
    const view = buildHerdViewModel(input({ createConversation: true }));
    expect(view.empty?.title).toBeTruthy();
    expect(view.empty?.action?.kind).toBe("create");
    expect(view.empty?.action?.disabled).toBe(false);
    expect(buildHerdViewModel(input({ createConversation: true, operationBusy: true })).empty?.action?.disabled).toBe(true);
    expect(buildHerdViewModel(input({ agents: [agent("p1", "alpha")] })).empty).toBeNull();
    expect(buildHerdViewModel(input({ networkOnline: false })).empty?.action?.kind).toBe("retry");
  });
});
