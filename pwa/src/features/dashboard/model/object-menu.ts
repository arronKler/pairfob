/**
 * Herd object menu model.
 *
 * Pure projection of one card (or one workspace heading) into the sheet the
 * reader gets: the fact rows above the list and the ordered actions with their
 * labels, danger flags and gates. Which operations those actions perform is the
 * caller's business; nothing here reads the record or mutates anything.
 */
import {
  agentDetailRows,
  agentTitle,
  tabIsSplit,
  visibleTabLabel,
  type AgentDetailRow,
} from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import type { AgentCard, ListGroup } from "../../../lib/ranking";

export type ObjectMenuKind =
  | "pin"
  | "newTabBeside"
  | "openBoard"
  | "renamePane"
  | "closePane"
  | "renameTab"
  | "closeTab"
  | "renameWorkspace"
  | "closeWorkspace"
  | "newTabInWorkspace";

export type ObjectMenuItem = { kind: ObjectMenuKind; label: string; danger?: boolean };

export type ObjectMenuModel = {
  title: string;
  facts: AgentDetailRow[];
  items: ObjectMenuItem[];
};

/**
 * The card menu. A workspace-grouped list moves the parent management to the
 * heading, and a tab is only renamable/closable when it is named or split.
 */
export function paneMenuModel(input: {
  agent: AgentCard;
  agents: AgentCard[];
  listGroup: ListGroup;
  pinned: boolean;
  createTab: boolean;
}): ObjectMenuModel {
  const { agent, agents, listGroup } = input;
  const split = tabIsSplit(agent, agents);
  const items: ObjectMenuItem[] = [
    { kind: "pin", label: t(input.pinned ? "menu.unpin" : "menu.pin") },
  ];
  if (agent.workspaceId && input.createTab) items.push({ kind: "newTabBeside", label: t("menu.newTabBeside") });
  if (agent.workspaceId) items.push({ kind: "openBoard", label: t("menu.board") });
  items.push({ kind: "renamePane", label: t("menu.renamePane") });
  items.push({ kind: "closePane", label: t("op.closePane"), danger: true });
  if (visibleTabLabel(agent.tabLabel) || split) items.push({ kind: "renameTab", label: t("menu.renameTab") });
  if (split) items.push({ kind: "closeTab", label: t("op.closeTab"), danger: true });
  if (agent.workspaceId && listGroup !== "space") {
    items.push({ kind: "renameWorkspace", label: t("menu.renameWorkspace") });
    items.push({ kind: "closeWorkspace", label: t("op.closeWorkspace"), danger: true });
  }
  return {
    // The sheet title is the card title the reader pressed.
    title: agentTitle(agent, listGroup),
    facts: agentDetailRows(agent, agents, listGroup),
    items,
  };
}

/** The workspace heading menu; null when the group has no real workspace. */
export function workspaceMenuModel(input: { agent: AgentCard; createTab: boolean }): ObjectMenuModel | null {
  const { agent } = input;
  if (!agent.workspaceId) return null;
  const items: ObjectMenuItem[] = [];
  if (input.createTab) items.push({ kind: "newTabInWorkspace", label: t("menu.newTabInWorkspace") });
  items.push({ kind: "renameWorkspace", label: t("menu.renameWorkspace") });
  items.push({ kind: "closeWorkspace", label: t("op.closeWorkspace"), danger: true });
  return { title: agent.workspaceLabel || t("workspace.unnamed"), facts: [], items };
}
