import { Ellipsis, MessageSquareText, SquareTerminal } from "lucide-react";
import { t } from "../../../lib/i18n";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { Immutable } from "../../../shared/model/domain-store";
import { useDashboard } from "../../dashboard/hooks";
import { blockedElsewhere, paneHeaderLine, paneIdentity } from "../../dashboard/model/herd-view";
import { usePreferences } from "../../settings/hooks";
import { useConnection, useRuntime } from "../../connection/hooks";
import { operationBusy } from "../../operations/capabilities-store";
import { herdLiveness } from "../../connection/runtime-status";
import type { SessionHandlers } from "./view";
import { useSession } from "../hooks";
import { AgentAvatar, BackButton, Button } from "../../../shared/ui/primitives";

/**
 * Whether the agent statuses on screen can no longer be confirmed. Subscribes to
 * the connection and runtime domains so a header re-renders the moment contact
 * is lost or regained, instead of keeping the last known status until an
 * unrelated update happens to repaint it.
 */
export function useStatusUnverifiable(): boolean {
  useConnection();
  useRuntime();
  return herdLiveness() === "unverifiable";
}

/**
 * One tap between the chat and terminal views of an agent pane. Leaving chat
 * picks Auto, which resolves to the complete terminal or the control view.
 * Agents without a readable transcript keep the button, disabled, so the
 * header does not shift between panes.
 */
function ViewToggle({ agent, handlers }: { agent: Immutable<DashboardAgentCard> | undefined; handlers: SessionHandlers }) {
  const chat = useSession().agentChat;
  if (!agent?.hasAgent) return null;
  const available = chat || handlers.chatAvailable(agent);
  const label = t(chat ? "head.toTerminal" : available ? "head.toChat" : "head.chatOff");
  return <Button className="icon-btn icon-view" aria-label={label} title={label} disabled={!available || operationBusy()}
    onClick={handlers.onToggleView}>
    {chat ? <SquareTerminal size={20} aria-hidden="true" /> : <MessageSquareText size={20} aria-hidden="true" />}
  </Button>;
}

/**
 * Shared trailing actions for guided, terminal and agent chat chrome: the view
 * toggle and the session menu (files live in the menu). Stopping a task lives
 * on the send button, so nothing here appears or disappears with the agent's status.
 */
export function SessionActions({ agent, handlers }: { agent?: Immutable<DashboardAgentCard>; handlers: SessionHandlers }) {
  return <div className="chrome-actions">
    <ViewToggle agent={agent} handlers={handlers} />
    <Button className="icon-btn icon-more" aria-label={t("pane.menuTitle")} disabled={operationBusy()}
      onClick={handlers.onMenu}><Ellipsis size={20} aria-hidden="true" /></Button>
  </div>;
}

/** Back to the list, carrying how many other panes are waiting on the reader. */
function SessionBack({ onBack, waiting }: { onBack: () => void; waiting: number }) {
  return <span className="chrome-back">
    <BackButton onBack={onBack} label={waiting ? t("chrome.backWaiting", { n: String(waiting) }) : t("chrome.backList")} />
    {waiting ? <span className="chrome-back-badge" aria-hidden="true">{waiting > 9 ? "9+" : waiting}</span> : null}
  </span>;
}

/**
 * The one session header for guided, agent chat and complete terminal.
 *
 * Display-only: the identity is the list card's own projection (same title,
 * status word and fact line, see `paneIdentity`), plus the workspace the list
 * would have shown as a group heading. It is not a button — switching sessions
 * happens on the list, reached through back or the edge swipe. The avatar and
 * title carry the classes the shared list ↔ pane transition names.
 */
export function SessionIdentity({ agent, fallbackTitle, includeBack, handlers, className = "", guided = false }: {
  agent: Immutable<DashboardAgentCard> | undefined;
  fallbackTitle: string;
  includeBack: boolean;
  handlers: SessionHandlers;
  className?: string;
  /** The guided header is the one `patchChromeTitle` repaints in place. */
  guided?: boolean;
}) {
  const agents = useDashboard().agents;
  const listGroup = usePreferences().listGroup;
  const stale = useStatusUnverifiable();
  const identity = agent ? paneIdentity(agent, listGroup, stale) : null;
  const line = agent && identity ? paneHeaderLine(identity, agent) : "";
  const waiting = blockedElsewhere(agents, agent?.paneId ?? "", stale);
  const title = identity?.title ?? fallbackTitle;
  const full = [title, identity?.statusLabel, line].filter(Boolean).join(" · ");
  return <header className={`chrome${className ? ` ${className}` : ""}`} data-react-session-chrome={guided ? "" : undefined}>
    {includeBack && <SessionBack onBack={handlers.onBack} waiting={waiting} />}
    <div className="chrome-title" title={full}>
      {identity ? <span className="chrome-avatar">
        <AgentAvatar kind={identity.kind === "agent" ? identity.agentKind : ""}
          status={identity.kind === "agent" ? identity.statusTone : undefined} />
      </span> : null}
      <span className="chrome-copy">
        <span className="chrome-name">{title}</span>
        {identity && (identity.statusLabel || line) ? <span className="chrome-meta">
          {identity.statusLabel ? <span className={`chrome-status is-${identity.statusTone}`}>{identity.statusLabel}</span> : null}
          {identity.statusLabel && line ? <span className="chrome-meta-sep" aria-hidden="true">·</span> : null}
          {line ? <span className="chrome-meta-text">{line}</span> : null}
        </span> : null}
      </span>
    </div>
    <SessionActions agent={agent} handlers={handlers} />
  </header>;
}

export function SessionChrome({ selected, includeBack, handlers }: {
  selected?: Immutable<DashboardAgentCard>; includeBack: boolean; handlers: SessionHandlers;
}) {
  return <SessionIdentity agent={selected} fallbackTitle={t("title.session")} includeBack={includeBack}
    handlers={handlers} guided />;
}
