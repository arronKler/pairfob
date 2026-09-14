import { t } from "../../lib/i18n";
import { MenuItem, showActionSheet, type ActionSheetController } from "../../shared/ui/overlay/action-sheet";
import { useHerdSessions } from "./hooks";
import { switchHerdSession } from "./actions";
import type { HerdSessionSummary } from "../../lib/protocol/session-ws";

function herdSessionLabel(session: HerdSessionSummary): string {
  return session.name ?? t("herdSessions.default");
}

function HerdSessionSwitcherBody({ modal }: { modal: ActionSheetController }) {
  const herd = useHerdSessions();
  return <>
    <div className="switch-list">{herd.sessions.map((session) => {
      const key = session.name ?? "";
      return <button key={key} type="button" className={`switch-item${session.name === herd.current ? " on" : ""}`}
        onClick={() => modal.close(() => switchHerdSession(session.name))}>
        <span className="switch-main">
          <span className="switch-head"><span className="switch-name">{herdSessionLabel(session)}</span></span>
          <span className="switch-meta">{session.running ? t("herdSessions.running") : t("herdSessions.stopped")}</span>
        </span>
      </button>;
    })}</div>
    <MenuItem modal={modal}>{t("cancel")}</MenuItem>
  </>;
}

export function openHerdSessionSwitcher(): void {
  showActionSheet(t("herdSessions.title"), (modal) => <HerdSessionSwitcherBody modal={modal} />);
}
