import { agentMeta, agentTitle, statusLabel } from "../../lib/dashboard";
import { groupAgents, paneIsPinned } from "../../lib/ranking";
import { t } from "../../lib/i18n";
import { openPane } from "../../live";
import { state } from "../../state";
import { Chevron, EmptyState } from "./chrome";
import { MenuItem, showActionSheet } from "./action-sheet";

export function openPaneSwitcher(): void {
  const agents = groupAgents(state.agents, state.listGroup, state.paneTouched, state.panePinned).flatMap(group => group.items);
  showActionSheet(t("home.switcherTitle"), modal => <>
    <div className="switch-list">{agents.length ? agents.map(agent => {
      const meta = [statusLabel(agent.status), agentMeta(agent, state.listGroup)].filter(Boolean).join(" · ");
      return <button key={agent.paneId} type="button" className={`switch-item${agent.paneId === state.paneId ? " on" : ""}`}
        onClick={() => modal.close(() => { if (agent.paneId !== state.paneId) void openPane(agent.paneId); })}>
        <span className="switch-main"><span className="switch-head">
          {paneIsPinned(state.panePinned, agent.paneId) && <span className="pin-mark" aria-hidden="true" />}
          <span className={`agent-dot agent-${agent.status}`} /><span className="switch-name">{agentTitle(agent, state.listGroup)}</span>
        </span>{meta && <span className="switch-meta">{meta}</span>}</span><Chevron />
      </button>;
    }) : <EmptyState spec={{ figure: "link", title: t("home.switcherEmptyTitle"), sub: t("home.switcherEmpty") }} />}</div>
    <MenuItem modal={modal}>{t("cancel")}</MenuItem>
  </>);
}
