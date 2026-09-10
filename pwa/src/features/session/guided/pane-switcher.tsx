import type { ReactElement } from "react";
import { agentMeta, agentTitle, statusLabel } from "../../../lib/dashboard";
import { groupAgents, paneIsPinned } from "../../../lib/ranking";
import { t } from "../../../lib/i18n";
import { openPane } from "../../../features/connection/controller";
import { useDashboard } from "../../dashboard/hooks";
import { usePreferences } from "../../settings/hooks";
import { useSession } from "../hooks";
import { openPaneId } from "../session-store";
import { Chevron, EmptyState } from "../../../shared/ui/primitives";
import { MenuItem, showActionSheet, type ActionSheetController } from "../../../shared/ui/overlay/action-sheet";

/**
 * The pane switcher sheet. Its list reads the dashboard and preference domain
 * snapshots it subscribes to; the click handler re-reads the canonical open
 * pane at action time so a later switch can never target a stale pane.
 */
function PaneSwitcherBody({ modal }: { modal: ActionSheetController }): ReactElement {
  const dashboard = useDashboard();
  const preferences = usePreferences();
  const session = useSession();
  const agents = groupAgents(
    dashboard.agents,
    preferences.listGroup,
    preferences.paneTouched,
    preferences.panePinned,
  ).flatMap((group) => group.items);
  const group = preferences.listGroup;
  return <>
    <div className="switch-list">{agents.length ? agents.map((agent) => {
      const meta = [statusLabel(agent.status), agentMeta(agent, group)].filter(Boolean).join(" · ");
      return <button key={agent.paneId} type="button" className={`switch-item${agent.paneId === session.paneId ? " on" : ""}`}
        onClick={() => modal.close(() => { if (agent.paneId !== openPaneId()) void openPane(agent.paneId); })}>
        <span className="switch-main"><span className="switch-head">
          {paneIsPinned(preferences.panePinned, agent.paneId) && <span className="pin-mark" aria-hidden="true" />}
          <span className={`agent-dot agent-${agent.status}`} /><span className="switch-name">{agentTitle(agent, group)}</span>
        </span>{meta && <span className="switch-meta">{meta}</span>}</span><Chevron />
      </button>;
    }) : <EmptyState spec={{ figure: "link", title: t("home.switcherEmptyTitle"), sub: t("home.switcherEmpty") }} />}</div>
    <MenuItem modal={modal}>{t("cancel")}</MenuItem>
  </>;
}

export function openPaneSwitcher(): void {
  showActionSheet(t("home.switcherTitle"), (modal) => <PaneSwitcherBody modal={modal} />);
}
