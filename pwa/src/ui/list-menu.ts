import { agentDetailRows, agentTitle, tabIsSplit, visibleTabLabel } from "../lib/dashboard";
import { node } from "../lib/dom";
import { t } from "../lib/i18n";
import { paneIsPinned, type AgentCard } from "../lib/ranking";
import { closePane, closeTab, closeWorkspace, createSelectedTab, renamePane, renameTab, renameWorkspace } from "../live-operations";
import { render } from "../paint";
import { state, togglePanePin } from "../state";
import { present, sheet, sheetItem } from "./sheet";

function appendPaneFacts(body: HTMLElement, agent: AgentCard): void {
  const rows = agentDetailRows(agent, state.agents, state.listGroup);
  if (!rows.length) return;
  const list = node("dl", "sheet-facts");
  for (const row of rows) {
    const item = node("div", "sheet-fact");
    const valueClass = row.kind === "path" ? "sheet-fact-val sheet-fact-path" : "sheet-fact-val";
    item.append(node("dt", "sheet-fact-key", row.key), node("dd", valueClass, row.value));
    list.append(item);
  }
  body.append(list);
}

export function openListPaneMenu(agent: AgentCard): void {
  const title = agentTitle(agent, state.listGroup);
  const parts = sheet(title);
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "") =>
    sheetItem(parts, label, action, variant);
  const split = tabIsSplit(agent, state.agents);
  const namedTab = Boolean(visibleTabLabel(agent.tabLabel));
  appendPaneFacts(parts.body, agent);
  const pinned = paneIsPinned(state.panePinned, agent.paneId);
  const canCreateTab = Boolean(agent.workspaceId && state.operationCapabilities.create_tab);
  parts.body.append(
    item(pinned ? t("menu.unpin") : t("menu.pin"), () => {
      togglePanePin(agent.paneId);
      render();
    }),
  );
  if (canCreateTab) parts.body.append(item(t("menu.newTabBeside"), () => createSelectedTab(agent)));
  parts.body.append(
    item(t("menu.renamePane"), () => renamePane(agent)),
    item(t("op.closePane"), () => closePane(agent), "danger"),
  );
  if (namedTab || split) parts.body.append(item(t("menu.renameTab"), () => renameTab(agent)));
  if (split) parts.body.append(item(t("op.closeTab"), () => closeTab(agent), "danger"));
  if (agent.workspaceId && state.listGroup !== "space") {
    parts.body.append(
      item(t("menu.renameWorkspace"), () => renameWorkspace(agent)),
      item(t("op.closeWorkspace"), () => closeWorkspace(agent), "danger"),
    );
  }
  present(parts);
}

export function openListWorkspaceMenu(agent: AgentCard): void {
  if (!agent.workspaceId) return;
  const parts = sheet(agent.workspaceLabel || t("workspace.unnamed"));
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "") =>
    sheetItem(parts, label, action, variant);
  if (state.operationCapabilities.create_tab) {
    parts.body.append(item(t("menu.newTabInWorkspace"), () => createSelectedTab(agent)));
  }
  parts.body.append(
    item(t("menu.renameWorkspace"), () => renameWorkspace(agent)),
    item(t("op.closeWorkspace"), () => closeWorkspace(agent), "danger"),
  );
  present(parts);
}
