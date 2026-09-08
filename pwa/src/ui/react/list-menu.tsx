import { agentDetailRows, agentTitle, tabIsSplit, visibleTabLabel } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import { paneIsPinned, type AgentCard } from "../../lib/ranking";
import { closePane, closeTab, closeWorkspace, createSelectedTab, renamePane, renameTab, renameWorkspace } from "../../live-operations";
import { render } from "../../paint";
import { state, togglePanePin } from "../../state";
import { openBoard } from "../board";
import { MenuItem, showActionSheet } from "./action-sheet";

export function openListPaneMenu(agent: AgentCard): void {
  const rows = agentDetailRows(agent, state.agents, state.listGroup);
  const split = tabIsSplit(agent, state.agents);
  const pinned = paneIsPinned(state.panePinned, agent.paneId);
  showActionSheet(agentTitle(agent, state.listGroup), modal => <>
    {rows.length > 0 && <dl className="sheet-facts">{rows.map((row, index) => <div key={index} className="sheet-fact">
      <dt className="sheet-fact-key">{row.key}</dt>
      <dd className={`sheet-fact-val${row.kind === "path" ? " sheet-fact-path" : ""}`}>{row.value}</dd>
    </div>)}</dl>}
    <MenuItem modal={modal} action={() => { togglePanePin(agent.paneId); render(); }}>{t(pinned ? "menu.unpin" : "menu.pin")}</MenuItem>
    {agent.workspaceId && state.operationCapabilities.create_tab && <MenuItem modal={modal} action={() => createSelectedTab(agent)}>{t("menu.newTabBeside")}</MenuItem>}
    {agent.workspaceId && <MenuItem modal={modal} action={() => openBoard({ workspaceId: agent.workspaceId, tabId: agent.tabId })}>{t("menu.board")}</MenuItem>}
    <MenuItem modal={modal} action={() => renamePane(agent)}>{t("menu.renamePane")}</MenuItem>
    <MenuItem modal={modal} action={() => closePane(agent)} danger>{t("op.closePane")}</MenuItem>
    {(visibleTabLabel(agent.tabLabel) || split) && <MenuItem modal={modal} action={() => renameTab(agent)}>{t("menu.renameTab")}</MenuItem>}
    {split && <MenuItem modal={modal} action={() => closeTab(agent)} danger>{t("op.closeTab")}</MenuItem>}
    {agent.workspaceId && state.listGroup !== "space" && <>
      <MenuItem modal={modal} action={() => renameWorkspace(agent)}>{t("menu.renameWorkspace")}</MenuItem>
      <MenuItem modal={modal} action={() => closeWorkspace(agent)} danger>{t("op.closeWorkspace")}</MenuItem>
    </>}
  </>);
}

export function openListWorkspaceMenu(agent: AgentCard): void {
  if (!agent.workspaceId) return;
  showActionSheet(agent.workspaceLabel || t("workspace.unnamed"), modal => <>
    {state.operationCapabilities.create_tab && <MenuItem modal={modal} action={() => createSelectedTab(agent)}>{t("menu.newTabInWorkspace")}</MenuItem>}
    <MenuItem modal={modal} action={() => renameWorkspace(agent)}>{t("menu.renameWorkspace")}</MenuItem>
    <MenuItem modal={modal} action={() => closeWorkspace(agent)} danger>{t("op.closeWorkspace")}</MenuItem>
  </>);
}
