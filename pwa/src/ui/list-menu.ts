import { agentTitle, tabIsSplit } from "../lib/dashboard";
import { button } from "../lib/dom";
import { t } from "../lib/i18n";
import { type AgentCard } from "../lib/ranking";
import { closePane, closeTab, renamePane, renameTab, renameWorkspace } from "../live-operations";
import { state } from "../state";
import { present, sheet, sheetItem, sheetSection } from "./sheet";

export function openListPaneMenu(agent: AgentCard): void {
  const title = agentTitle(agent, state.listGroup);
  const parts = sheet(title);
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "") =>
    sheetItem(parts, label, action, variant);
  sheetSection(parts, t("menu.thisPane"), [
    item(t("menu.renamePane"), () => renamePane(agent)),
    item(t("op.closePane"), () => closePane(agent), "danger"),
  ]);
  const tabItems = [
    ...(agent.tabId ? [item(t("menu.renameTab"), () => renameTab(agent))] : []),
    ...(tabIsSplit(agent, state.agents) ? [item(t("op.closeTab"), () => closeTab(agent), "danger")] : []),
  ];
  sheetSection(parts, t("menu.tab"), tabItems);
  if (agent.workspaceId) {
    sheetSection(parts, t("menu.workspace"), [item(t("menu.renameWorkspace"), () => renameWorkspace(agent))]);
  }
  parts.body.append(button(t("cancel"), "menu-item", parts.close));
  present(parts);
}
