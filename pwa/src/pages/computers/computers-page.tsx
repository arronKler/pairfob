import { useComputers } from "../../features/computers/hooks";
import { useConnection } from "../../features/connection/hooks";
import { useNavigation } from "../../app/domain-hooks";
import { useSession } from "../../features/session/hooks";
import { beginAddComputer, computersPageInput, forgetComputer, leaveComputers, switchComputer } from "../../features/computers/actions";
import { ComputerListView } from "../../features/computers/computer-list-view";
import { computersViewModel } from "../../features/computers/model";
import { AppNotice } from "../../app/notice";
import { ManualUpdateHelp } from "../../features/settings/daemon-update-view";
import { isDesk } from "../../app/viewport";

/**
 * Computers page composition.
 *
 * Subscribes to the computers, connection, navigation and session domains so a
 * typed catalog/phase/pane change updates an already-mounted picker without a
 * global paint. The view input is projected from those subscribed, published
 * domain snapshots (`computersPageInput`), so a staged composition hold keeps
 * the picker on the same published phase/catalog as its frame; canonical
 * action-time readers stay with the click/async handlers.
 *
 * Back goes through `leaveComputers` so a pending forget sees the navigation
 * intent. `AppNotice` and `ManualUpdateHelp` stay imported from their current
 * entries until those owners migrate.
 */

function useComputersView(withBack: boolean) {
  const computers = useComputers();
  const connection = useConnection();
  const navigation = useNavigation();
  const session = useSession();
  // Project from the subscribed snapshots: a staged composition hold keeps the
  // picker on the same published phase/catalog as its frame.
  return computersViewModel(computersPageInput(withBack, isDesk(), { connection, computers, navigation, session }));
}

export function ComputersContent({ withBack }: { withBack: boolean }) {
  const view = useComputersView(withBack);
  return (
    <ComputerListView
      view={view}
      onSwitch={daemonId => void switchComputer(daemonId)}
      onForget={daemonId => void forgetComputer(daemonId)}
      onAdd={beginAddComputer}
      onBack={() => leaveComputers(view.backTarget)}
      notice={<AppNotice />}
      footer={view.showManualUpdateHelp ? <ManualUpdateHelp /> : null}
    />
  );
}

export function ComputersScreen() {
  useComputers();
  const connection = useConnection();
  useNavigation();
  useSession();
  const live = connection.phase === "live";
  return (
    <div className={live ? "page settings-page" : "page"}>
      <ComputersContent withBack={live} />
    </div>
  );
}
