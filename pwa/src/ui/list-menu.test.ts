import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./list-menu.ts", import.meta.url)).text();
const home = await Bun.file(new URL("./home.ts", import.meta.url)).text();
const press = await Bun.file(new URL("./press-menu.ts", import.meta.url)).text();

describe("list object menu", () => {
  test("card actions target the card's agent, not the open pane", () => {
    expect(source).toContain("export function openListPaneMenu(agent: AgentCard)");
    expect(source).toContain("renamePane(agent)");
    expect(source).toContain("closePane(agent)");
    expect(source).toContain("togglePanePin(agent.paneId)");
    expect(source).toContain('t("menu.pin")');
    expect(source).toContain('t("menu.unpin")');
    expect(source).toContain("renameTab(agent)");
    expect(source).toContain("closeTab(agent)");
    expect(source).toContain("renameWorkspace(agent)");
    expect(source).toContain("closeWorkspace(agent)");
    expect(source).toContain("createSelectedTab(agent)");
    expect(source).not.toContain("selectedAgent()");
    expect(source).not.toContain("state.paneId");
  });

  test("tab rename needs a visible tab name or a split; close is split-only", () => {
    expect(source).toContain("visibleTabLabel(agent.tabLabel)");
    expect(source).toContain("tabIsSplit(agent, state.agents)");
    expect(source).toContain('t("menu.renameTab")');
    expect(source).toContain('t("op.closeTab")');
    expect(source).toContain('t("op.closeWorkspace")');
    expect(source).not.toContain("sheetSection");
    expect(source).not.toContain('t("cancel")');
  });

  test("the object menu lists full pane facts above the actions", () => {
    expect(source).toContain("agentDetailRows(agent, state.agents, state.listGroup)");
    expect(source).toContain("sheet-facts");
    expect(source).toContain("sheet-fact-path");
    const facts = source.slice(source.indexOf("function appendPaneFacts"), source.indexOf("export function openListPaneMenu"));
    expect(facts).not.toContain("paneId");
  });

  test("workspace rename leaves the card when the list is grouped by workspace", () => {
    expect(source).toContain('state.listGroup !== "space"');
    expect(source).toContain("export function openListWorkspaceMenu");
    expect(home).toContain('state.listGroup === "space" && group.id !== PINNED_GROUP_ID');
    expect(home).toContain("openListWorkspaceMenu(agent)");
    expect(source).not.toContain("list_worktrees");
  });

  test("the list can create a tab in the card's workspace, not a split", () => {
    expect(source).toContain("state.operationCapabilities.create_tab");
    expect(source).toContain('t("menu.newTabBeside")');
    expect(source).toContain('t("menu.newTabInWorkspace")');
    expect(source).toContain("createSelectedTab(agent)");
    expect(source).not.toContain("splitSelectedPane");
    expect(source).not.toContain('t("menu.split")');
  });

  test("the list card is one control; long-press opens the object menu", () => {
    expect(home).toContain("bindObjectPress(main");
    expect(home).toContain("openListPaneMenu(agent)");
    expect(home).toContain('aria-haspopup", "menu"');
    expect(home).not.toContain("card-more");
    expect(home).not.toContain("card-split");
    expect(press).toContain("HOLD_MS = 450");
    expect(press).toContain('addEventListener("contextmenu"');
    expect(press).toContain("stopImmediatePropagation");
  });
});
