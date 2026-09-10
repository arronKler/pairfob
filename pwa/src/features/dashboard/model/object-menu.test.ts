import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import { paneMenuModel, workspaceMenuModel, type ObjectMenuKind } from "./object-menu";

function agent(id: string, extra: Partial<DashboardAgentCard> = {}): DashboardAgentCard {
  return {
    paneId: id, paneLabel: "Target", agent: "codex", hasAgent: true, status: "idle",
    workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project", ...extra,
  };
}

function kinds(items: Array<{ kind: ObjectMenuKind }>): ObjectMenuKind[] {
  return items.map((item) => item.kind);
}

const plain = { agents: [agent("p2")], listGroup: "flat", pinned: false, createTab: false } as const;

beforeEach(() => setLang("zh"));

describe("pane object menu model", () => {
  test("the base card menu keeps its order, facts and title", () => {
    const model = paneMenuModel({ agent: agent("p2"), ...plain });
    expect(model.title).toBe("Target");
    expect(kinds(model.items)).toEqual(["pin", "openBoard", "renamePane", "closePane", "renameWorkspace", "closeWorkspace"]);
    expect(model.items.map((item) => item.label)).toEqual([
      t("menu.pin"), t("menu.board"), t("menu.renamePane"), t("op.closePane"),
      t("menu.renameWorkspace"), t("op.closeWorkspace"),
    ]);
    expect(model.items.map((item) => item.danger === true)).toEqual([false, false, false, true, false, true]);
    expect(model.facts.map((row) => row.key)).toContain(t("detail.path"));
    expect(model.facts.find((row) => row.kind === "path")?.value).toBe("/two/project");
  });

  test("a pinned card is offered unpin, and the pin targets the card not the open pane", () => {
    expect(paneMenuModel({ agent: agent("p2"), ...plain, pinned: true }).items[0].label).toBe(t("menu.unpin"));
  });

  test("create_tab adds the beside-tab entry only for a card with a workspace", () => {
    expect(kinds(paneMenuModel({ agent: agent("p2"), ...plain, createTab: true }).items))
      .toEqual(["pin", "newTabBeside", "openBoard", "renamePane", "closePane", "renameWorkspace", "closeWorkspace"]);
    const homeless = paneMenuModel({ agent: agent("p2", { workspaceId: "", workspaceLabel: "" }), ...plain, createTab: true });
    expect(kinds(homeless.items)).toEqual(["pin", "renamePane", "closePane"]);
  });

  test("tab rename needs a visible label or a split, tab close needs a split", () => {
    const named = paneMenuModel({ agent: agent("p2", { tabLabel: "Review" }), ...plain });
    expect(kinds(named.items)).toContain("renameTab");
    expect(kinds(named.items)).not.toContain("closeTab");
    const split = paneMenuModel({
      agent: agent("p2"),
      agents: [agent("p2"), agent("p3")],
      listGroup: "flat",
      pinned: false,
      createTab: false,
    });
    expect(kinds(split.items)).toContain("renameTab");
    expect(kinds(split.items)).toContain("closeTab");
    expect(split.items.find((item) => item.kind === "closeTab")?.danger).toBe(true);
    expect(kinds(paneMenuModel({ agent: agent("p2", { tabLabel: "main" }), ...plain }).items)).not.toContain("renameTab");
  });

  test("workspace grouping moves parent management to the heading menu", () => {
    const grouped = paneMenuModel({ agent: agent("p2"), agents: [agent("p2")], listGroup: "space", pinned: false, createTab: false });
    expect(kinds(grouped.items)).toEqual(["pin", "openBoard", "renamePane", "closePane"]);
    expect(grouped.title).toBe("Target");
  });

  test("the sheet title follows the grouping the reader is looking at", () => {
    const nameless = agent("p2", { paneLabel: undefined });
    expect(paneMenuModel({ agent: nameless, ...plain }).title).toBe("Two");
    const grouped = paneMenuModel({
      agent: nameless, agents: [nameless], listGroup: "space", pinned: false, createTab: false,
    });
    expect(grouped.title).toBe("codex");
    // The facts keep the full coordinates in every grouping.
    expect(grouped.facts.map((row) => row.value)).toContain("Two");
    expect(paneMenuModel({ agent: agent("p2"), ...plain }).facts.map((row) => row.value)).toContain("Two");
  });
});

describe("workspace object menu model", () => {
  test("a heading without a real workspace opens nothing", () => {
    expect(workspaceMenuModel({ agent: agent("p2", { workspaceId: "" }), createTab: true })).toBeNull();
  });

  test("the heading menu is rename and close, with new tab first when advertised", () => {
    expect(kinds(workspaceMenuModel({ agent: agent("p2"), createTab: false })!.items))
      .toEqual(["renameWorkspace", "closeWorkspace"]);
    const advertised = workspaceMenuModel({ agent: agent("p2"), createTab: true })!;
    expect(kinds(advertised.items)).toEqual(["newTabInWorkspace", "renameWorkspace", "closeWorkspace"]);
    expect(advertised.items[0].label).toBe(t("menu.newTabInWorkspace"));
    expect(advertised.items[2].danger).toBe(true);
    expect(advertised.title).toBe("Two");
    expect(advertised.facts).toEqual([]);
  });

  test("an unnamed workspace still gets a title", () => {
    expect(workspaceMenuModel({ agent: agent("p2", { workspaceLabel: "" }), createTab: false })!.title)
      .toBe(t("workspace.unnamed"));
  });
});
