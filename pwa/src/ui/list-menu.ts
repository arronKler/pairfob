import { agentTitle, tabIsSplit, visibleTabLabel } from "../lib/dashboard";
import { t } from "../lib/i18n";
import { type AgentCard } from "../lib/ranking";
import { closePane, closeTab, renamePane, renameTab, renameWorkspace } from "../live-operations";
import { state } from "../state";
import { present, sheet, sheetItem } from "./sheet";

export function openListPaneMenu(agent: AgentCard): void {
  const title = agentTitle(agent, state.listGroup);
  const parts = sheet(title);
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "") =>
    sheetItem(parts, label, action, variant);
  const split = tabIsSplit(agent, state.agents);
  const namedTab = Boolean(visibleTabLabel(agent.tabLabel));
  parts.body.append(item(t("menu.renamePane"), () => renamePane(agent)), item(t("op.closePane"), () => closePane(agent), "danger"));
  if (namedTab || split) parts.body.append(item(t("menu.renameTab"), () => renameTab(agent)));
  if (split) parts.body.append(item(t("op.closeTab"), () => closeTab(agent), "danger"));
  if (agent.workspaceId && state.listGroup !== "space") {
    parts.body.append(item(t("menu.renameWorkspace"), () => renameWorkspace(agent)));
  }
  present(parts);
}

export function openListWorkspaceMenu(agent: AgentCard): void {
  if (!agent.workspaceId) return;
  const parts = sheet(agent.workspaceLabel || t("workspace.unnamed"));
  parts.body.append(sheetItem(parts, t("menu.renameWorkspace"), () => renameWorkspace(agent)));
  present(parts);
}
