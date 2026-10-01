import { Monitor, Plus, RefreshCw, Server, SlidersHorizontal } from "lucide-react";
import { beginAddComputer, machineLinks, openComputers, switchComputer } from "../../features/computers/actions";
import { computersStore, currentDaemonId } from "../../features/computers/catalog-store";
import { reconnectLiveSessions } from "../../features/connection/controller";
import { openSettingsSection } from "../../features/settings/actions";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { MenuChoice, showActionSheet } from "../../shared/ui/overlay";
import type { HerdHostView } from "../../features/dashboard/model/herd-view";

/**
 * The computer panel behind the phone header title. It replaces the old top
 * bar's Computers link and status line: which computer, how it is reached, a
 * retry while contact is lost, switching, connection details, adding one, and
 * the machines this computer reaches when it can link them.
 */
export function openHostMenu(host: HerdHostView): void {
  const current = currentDaemonId();
  const computers = computersStore.get().computers;
  showActionSheet(t("host.sheetTitle"), (modal) => (
    <>
      {host.tone !== "live" && host.tone !== "demo" ? (
        <MenuChoice modal={modal} icon={<RefreshCw size={18} aria-hidden="true" />} title={t("host.retry")}
          action={() => reconnectLiveSessions("probe")} />
      ) : null}
      {computers.map((pair) => {
        const selected = pair.daemonId === current;
        return (
          <MenuChoice key={pair.daemonId} modal={modal} icon={<Monitor size={18} aria-hidden="true" />}
            title={selected ? host.name : computerTitle(pair)}
            detail={selected ? host.line : undefined}
            selected={selected}
            action={selected ? undefined : () => switchComputer(pair.daemonId)} />
        );
      })}
      <MenuChoice modal={modal} icon={<SlidersHorizontal size={18} aria-hidden="true" />} title={t("host.details")}
        action={() => openSettingsSection("connection")} />
      <MenuChoice modal={modal} icon={<Plus size={18} aria-hidden="true" />} title={t("host.add")}
        action={beginAddComputer} />
      {machineLinks.view().machines.length ? (
        <MenuChoice modal={modal} icon={<Server size={18} aria-hidden="true" />} title={t("machines.menu", { host: host.name })}
          action={openComputers} />
      ) : null}
    </>
  ), { subtitle: host.line });
}
