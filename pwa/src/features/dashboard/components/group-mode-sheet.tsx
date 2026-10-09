import { Bot, ChevronsDownUp, ChevronsUpDown, Folder, List } from "lucide-react";
import { t } from "../../../lib/i18n";
import { groupAgents, type ListGroup } from "../../../lib/ranking";
import { MenuChoice, showActionSheet } from "../../../shared/ui/overlay";
import { dashboardStore } from "../catalog-store";
import { listGroup, paneActivated, panePinned, setListGroupCollapsed } from "../../settings/preferences-store";
import { chooseListGroup } from "./herd-controls";

/** Fold or open every group the current grouping shows. */
function foldAll(collapsed: boolean): void {
  const groups = groupAgents([...dashboardStore.get().agents], listGroup(), paneActivated(), panePinned());
  setListGroupCollapsed(Object.fromEntries(groups.map((group) => [group.id, collapsed])));
}

/** The grouping sheet behind the header button: pick a grouping, fold all, open all. */
export function openGroupModeSheet(): void {
  const current = listGroup();
  const options: Array<{ id: ListGroup; title: string; detail: string; icon: typeof Folder }> = [
    { id: "space", title: t("list.modeSpace"), detail: t("list.spaceSub"), icon: Folder },
    { id: "agent", title: t("list.modeAgent"), detail: t("list.agentSub"), icon: Bot },
    { id: "flat", title: t("list.modeFlat"), detail: t("list.flatSub"), icon: List },
  ];
  showActionSheet(t("list.modeSheet"), (modal) => (
    <>
      {options.map(({ id, title, detail, icon: Icon }) => (
        <MenuChoice key={id} modal={modal} icon={<Icon size={18} aria-hidden="true" />} title={title} detail={detail}
          selected={current === id} action={() => chooseListGroup(id)} />
      ))}
      {current !== "flat" ? <>
        <MenuChoice modal={modal} icon={<ChevronsUpDown size={18} aria-hidden="true" />} title={t("list.expandAll")}
          action={() => foldAll(false)} />
        <MenuChoice modal={modal} icon={<ChevronsDownUp size={18} aria-hidden="true" />} title={t("list.collapseAll")}
          action={() => foldAll(true)} />
      </> : null}
    </>
  ), { popover: "menu" });
}
