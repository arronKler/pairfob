import { Pencil, Plus, Trash2 } from "lucide-react";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import { liveBoardCatalog } from "../../features/board/layout-store";
import { boardTabLabel } from "../../features/board/model/board-view";
import { liveAgents } from "../../features/dashboard/catalog-store";
import { capabilityEnabled } from "../../features/operations/capabilities-store";
import { closeTab, renameTab } from "../../features/operations/controller";
import { MenuChoice, MenuSection, showActionSheet } from "../../shared/ui/overlay";
import { boardCommandReason } from "./board-layout-ops";

/**
 * One tab's menu: rename, a new tab beside it, and close. Rename and close run
 * the same flows as the session list (their dialogs name the tab and, for
 * close, how many sessions end), addressed through a pane card of that tab.
 */
export function openBoardTabMenu(tabId: string, createTab: () => void): void {
  const catalog = liveBoardCatalog();
  const index = catalog.tabList.filter((tab) => tab.workspaceId === catalog.workspaceId).findIndex((tab) => tab.id === tabId);
  const tab = catalog.tabList.find((item) => item.id === tabId);
  if (!tab) return;
  const agents = liveAgents() as DashboardAgentCard[];
  const inside = agents.filter((card) => card.tabId === tabId && card.workspaceId === tab.workspaceId);
  const card = inside[0];
  const reason = boardCommandReason();
  const blocked = reason || (!card ? t("boardMenu.targetGone") : "");
  showActionSheet(boardTabLabel(tab, Math.max(0, index), agents), (modal) => <>
    <MenuChoice modal={modal} icon={<Pencil size={18} aria-hidden="true" />} title={t("boardMenu.renameTab")}
      detail={blocked || undefined} disabled={!!blocked} action={() => renameTab(card)} />
    {capabilityEnabled("create_tab") ? <MenuChoice modal={modal} icon={<Plus size={18} aria-hidden="true" />} title={t("boardMenu.newTab")}
      detail={reason || undefined} disabled={!!reason} action={createTab} /> : null}
    <MenuSection title={t("boardMenu.groupManage")}>
      <MenuChoice modal={modal} danger icon={<Trash2 size={18} aria-hidden="true" />} title={t("boardMenu.closeTab")}
        detail={blocked || undefined} disabled={!!blocked} action={() => closeTab(card)} />
    </MenuSection>
  </>, { subtitle: t("boardMenu.tabPanes", { n: inside.length }) });
}
