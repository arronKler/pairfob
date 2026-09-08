import { Fragment, useRef, type CSSProperties } from "react";
import { agentMeta, agentTitle, statusLabel } from "../../lib/dashboard";
import { openHerdPaint, type HerdPaint } from "../../lib/herd-attention";
import { t } from "../../lib/i18n";
import { groupAgents, paneIsPinned, PINNED_GROUP_ID, syncGroupCollapsed, toggleGroupCollapsed,
  type AgentCard as Agent, type AgentGroup } from "../../lib/ranking";
import { emptySessionCopy, type EmptySessionAction } from "../../lib/ui-model";
import { openComputers } from "../../computers";
import { openPane, reconnectLiveSessions } from "../../live";
import { startNewConversation } from "../../live-operations";
import { openSettings } from "../../live-settings";
import { render } from "../../paint";
import { haptic, state, type StatusTone } from "../../state";
import { openBoard } from "../board";
import { herdLiveness, herdStatus, type EmptySpec } from "../chrome";
import { openListPaneMenu, openListWorkspaceMenu } from "../list-menu";
import { morphingPane, shareTitle } from "../transition";
import { AppNotice, Brand, Button, Chevron, CompletionCount, EmptyState, HerdBanners, ListGroupControl, StatusDot } from "./chrome";
import { DaemonUpdate } from "./daemon-update";
import { useObjectPress } from "./object-press";
import { WorktreeProgressList } from "./worktree-progress";

export type HerdView = { paint: HerdPaint; groups: AgentGroup[] };

/** Consume attention once in the render controller, before React's pure view. */
export function prepareHerdView(): HerdView {
  const paint = openHerdPaint(state.agents, state.listGroup);
  if (paint.completed.length && document.visibilityState === "visible") haptic(14);
  const groups = groupAgents(state.agents, state.listGroup, state.paneTouched, state.panePinned);
  if (state.listGroup !== "flat") state.listGroupCollapsed = syncGroupCollapsed(groups, state.listGroupCollapsed);
  return { paint, groups };
}

function indexed(index: number): CSSProperties {
  return { "--i": String(index) } as CSSProperties;
}

function AgentCard({ agent, paint, index }: { agent: Agent; paint: HerdPaint; index: number }) {
  const title = useRef<HTMLDivElement>(null);
  const press = useObjectPress(() => {
    if (!state.operationBusy && state.live?.isConnected()) openListPaneMenu(agent);
  });
  const selected = agent.paneId === state.paneId;
  const pinned = paneIsPinned(state.panePinned, agent.paneId);
  const stale = herdLiveness() === "unverifiable";
  const mark = paint.markOf(agent.paneId);
  const attention = (mark ? mark === "done" ? " ac-changed ac-done" : " ac-changed" : "")
    + (paint.isDismissing(agent.paneId) ? " attn-out" : "");
  const pill = stale ? t("status.unverifiable") : statusLabel(agent.status);
  const meta = agentMeta(agent, state.listGroup);
  return <article className={`card status-${agent.status}${stale ? " unverifiable" : ""}${selected ? " sel" : ""}${pinned ? " pinned" : ""}${attention}`}
    style={indexed(index)}>
    <Button ref={press} className="card-main" aria-pressed={selected} aria-haspopup="menu" onClick={() => {
      shareTitle(title.current);
      void openPane(agent.paneId);
    }}>
      <div className="card-copy">
        <div className="card-title" ref={title} style={morphingPane() === agent.paneId ? { viewTransitionName: "pane-title" } : undefined}>
          {pinned && <><span className="pin-mark" aria-hidden="true" /><span className="sr-only">{t("home.pinned")}</span></>}
          <span className="card-name">{agentTitle(agent, state.listGroup)}</span>
          {pill && <span className={`pill pill-${stale ? "unknown" : agent.status}`}>{pill}</span>}
        </div>
        {meta && <p className="card-meta">{meta}</p>}
      </div>
      <Chevron />
    </Button>
  </article>;
}

function emptyAction(kind: EmptySessionAction | undefined): EmptySpec["action"] {
  if (kind === "create") return { label: t("empty.actionCreate"), run: startNewConversation,
    disabled: state.operationBusy || !state.live?.isConnected() };
  if (kind === "retry") return { label: t("empty.actionRetry"), run: () => reconnectLiveSessions("probe") };
  if (kind === "settings") return { label: t("empty.actionSettings"), run: openSettings };
}

function HerdGroup({ group, view, index }: { group: AgentGroup; view: HerdView; index: number }) {
  const collapsed = state.listGroupCollapsed[group.id] === true;
  const agent = group.items.find(item => item.workspaceId) ?? group.items[0];
  const hasMenu = state.listGroup === "space" && group.id !== PINNED_GROUP_ID && !!agent?.workspaceId;
  const press = useObjectPress(() => {
    if (!state.operationBusy && state.live?.isConnected()) openListWorkspaceMenu(agent);
  }, hasMenu);
  return <section className="herd-group">
    <Button ref={press} className="group-title" aria-expanded={!collapsed} aria-haspopup={hasMenu ? "menu" : undefined}
      style={indexed(index)} onClick={() => {
        state.listGroupCollapsed = toggleGroupCollapsed(view.groups, state.listGroupCollapsed, group.id);
        render();
      }}>
      <Chevron className="group-chev" /><span className="group-name">{group.title}</span>
      {group.items.length > 0 && <span className="section-count">{group.items.length}</span>}
    </Button>
    <div className="herd-group-body" hidden={collapsed}>
      {group.items.map((item, i) => <AgentCard key={item.paneId} agent={item} paint={view.paint} index={index + i + 1} />)}
    </div>
  </section>;
}

function HerdList({ view }: { view: HerdView }) {
  let position = 0;
  const copy = emptySessionCopy(state.runtimeKind, state.live?.isConnected() === true,
    state.operationCapabilities.create_conversation, state.networkOnline);
  return <>
    <DaemonUpdate compact /><WorktreeProgressList /><ListGroupControl />
    {!state.agents.length ? <EmptyState spec={{ title: copy.title, sub: copy.detail, figure: "panes", action: emptyAction(copy.action) }} />
      : <div className={`herd-list${view.paint.stagger ? " enter" : ""}`}>
        {view.groups.map(group => {
          const index = position;
          position += group.items.length + 1;
          return state.listGroup === "flat" ? <Fragment key={group.id}>
            <h2 className="section-title" style={indexed(index)}>{group.title}
              {group.items.length > 0 && <span className="section-count">{group.items.length}</span>}
            </h2>
            {group.items.map((agent, i) => <AgentCard key={agent.paneId} agent={agent} paint={view.paint} index={index + i + 1} />)}
          </Fragment> : <HerdGroup key={group.id} group={group} view={view} index={index} />;
        })}
      </div>}
  </>;
}

function LiveActions() {
  return <div className="topbar-actions">
    {state.operationCapabilities.create_conversation && <Button className="topbar-create" onClick={startNewConversation}
      disabled={state.operationBusy || !state.live?.isConnected()} aria-label={t("home.newAria")}>
      {state.operationBusy ? t("home.creating") : t("home.new")}
    </Button>}
    {state.computers.length > 1 && <Button className="text-link" onClick={openComputers}>{t("home.computers")}</Button>}
    <Button className="text-link" onClick={() => void openBoard()}>{t("home.board")}</Button>
    <Button className="text-link" onClick={openSettings}>{t("home.settings")}</Button>
  </div>;
}

function HomeStatus({ status }: { status: { tone: StatusTone; text: string } }) {
  return <p className="statusline"><StatusDot tone={status.tone} /><span className="statusline-text">{status.text}</span>
    <CompletionCount count={state.agents.filter(agent => agent.status === "done").length} />
  </p>;
}

export function HomeScreen({ view }: { view: HerdView }) {
  const status = herdStatus();
  return <div className="page">
    <div className="topbar"><Brand tone={status.tone} heading /><LiveActions /></div>
    <HomeStatus status={status} /><HerdBanners tone={status.tone} /><AppNotice /><HerdList view={view} />
  </div>;
}

export function HomeRail({ view }: { view: HerdView }) {
  const status = herdStatus();
  return <aside className="rail">
    <div className="topbar"><Brand tone={status.tone} heading /><LiveActions /></div>
    <HomeStatus status={status} /><HerdBanners tone={status.tone} /><HerdList view={view} />
  </aside>;
}
