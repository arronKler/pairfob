/**
 * Herd object menu model.
 *
 * Pure projection of one card (or one workspace heading) into the sheet the
 * reader gets: the fact rows above the list and the ordered actions with their
 * labels, what each acts on, danger flags and gates. Which operations those actions perform is the
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

/** What an action acts on. A menu is cut into sections by it, in this order. */
export type ObjectMenuScope = "pane" | "tab" | "workspace";

export type ObjectMenuItem = { kind: ObjectMenuKind; label: string; scope: ObjectMenuScope; danger?: boolean };

export type ObjectMenuModel = {
  title: string;
  facts: AgentDetailRow[];
  /**
   * In reading order: this session, then its tab, then its workspace, and
   * inside each the action that destroys it last.
   */
  items: ObjectMenuItem[];
};

export type ObjectMenuSection = { scope: ObjectMenuScope; title: string; items: ObjectMenuItem[] };

const SCOPE_TITLE = { pane: "menu.thisPane", tab: "menu.tab", workspace: "menu.workspace" } as const;

/**
 * The menu's runs of rows about one object. A menu about a single object is
 * one untitled run: the row or heading it opened from already names it.
 */
export function objectMenuSections(model: ObjectMenuModel): ObjectMenuSection[] {
  const sections: ObjectMenuSection[] = [];
  for (const item of model.items) {
    const last = sections.at(-1);
    if (last?.scope === item.scope) last.items.push(item);
    else sections.push({ scope: item.scope, title: "", items: [item] });
  }
  return sections.length > 1 ? sections.map(section => ({ ...section, title: t(SCOPE_TITLE[section.scope]) })) : sections;
}

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
    { kind: "pin", label: t(input.pinned ? "menu.unpin" : "menu.pin"), scope: "pane" },
    { kind: "renamePane", label: t("menu.renamePane"), scope: "pane" },
    { kind: "closePane", label: t("op.closePane"), scope: "pane", danger: true },
  ];
  if (agent.workspaceId) items.push({ kind: "openBoard", label: t("menu.board"), scope: "tab" });
  if (visibleTabLabel(agent.tabLabel) || split) items.push({ kind: "renameTab", label: t("menu.renameTab"), scope: "tab" });
  if (split) items.push({ kind: "closeTab", label: t("op.closeTab"), scope: "tab", danger: true });
  if (agent.workspaceId && input.createTab) items.push({ kind: "newTabBeside", label: t("menu.newTabBeside"), scope: "workspace" });
  if (agent.workspaceId && listGroup !== "space") {
    items.push({ kind: "renameWorkspace", label: t("menu.renameWorkspace"), scope: "workspace" });
    items.push({ kind: "closeWorkspace", label: t("op.closeWorkspace"), scope: "workspace", danger: true });
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
  if (input.createTab) items.push({ kind: "newTabInWorkspace", label: t("menu.newTabInWorkspace"), scope: "workspace" });
  // Switches to the Board tab with this workspace selected.
  items.push({ kind: "openBoard", label: t("menu.openInBoard"), scope: "workspace" });
  items.push({ kind: "renameWorkspace", label: t("menu.renameWorkspace"), scope: "workspace" });
  items.push({ kind: "closeWorkspace", label: t("op.closeWorkspace"), scope: "workspace", danger: true });
  return { title: agent.workspaceLabel || t("workspace.unnamed"), facts: [], items };
}
