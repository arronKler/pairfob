import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./list-menu.ts", import.meta.url)).text();
const home = await Bun.file(new URL("./home.ts", import.meta.url)).text();

describe("list object menu", () => {
  test("card actions target the card's agent, not the open pane", () => {
    expect(source).toContain("export function openListPaneMenu(agent: AgentCard)");
    expect(source).toContain("renamePane(agent)");
    expect(source).toContain("closePane(agent)");
    expect(source).toContain("renameTab(agent)");
    expect(source).toContain("closeTab(agent)");
    expect(source).toContain("renameWorkspace(agent)");
    expect(source).not.toContain("selectedAgent()");
    expect(source).not.toContain("state.paneId");
  });

  test("tab close is only offered for a split tab; rename needs a tab id", () => {
    expect(source).toContain("agent.tabId");
    expect(source).toContain("tabIsSplit(agent, state.agents)");
    expect(source).toContain('t("menu.renameTab")');
    expect(source).toContain('t("op.closeTab")');
    expect(source).not.toContain("visibleTabLabel");
  });

  test("workspace rename lives on the card, not only on a group heading", () => {
    expect(source).toContain("agent.workspaceId");
    expect(source).toContain('t("menu.workspace")');
    expect(source).not.toContain("list_worktrees");
    expect(source).not.toContain("createSelectedTab");
  });

  test("the list card is a container with two controls", () => {
    expect(home).toContain("openListPaneMenu(agent)");
    expect(home).toContain('button("", "card-main"');
    expect(home).toContain("card-more");
    expect(home).toContain("card-split");
    expect(home).not.toContain('setAttribute("role", "button")');
    expect(home).not.toContain("card.tabIndex");
    expect(home).toContain("event.stopPropagation()");
  });
});
