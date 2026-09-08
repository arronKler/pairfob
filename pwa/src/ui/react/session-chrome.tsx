import { useLayoutEffect, useRef } from "react";
import { agentMeta, agentTitle, chromeName, cwdName, statusLabel, tabIsSplit } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import type { AgentCard } from "../../lib/ranking";
import { haptic, state } from "../../state";
import { canInterruptAgent, herdLiveness } from "../chrome";
import type { SessionHandlers } from "../session/view";
import { queueKey } from "../session/keys";
import { morphingPane, shareTitle } from "../transition";
import { BackButton, Button } from "./chrome";

/** Shared trailing actions for guided, terminal and agent chat chrome. */
export function SessionActions({ onWorkspace, onMenu, onStop, working }: {
  onWorkspace: () => void; onMenu: () => void; onStop: () => void; working: boolean;
}) {
  return <div className="chrome-actions">
    {working && <Button className="icon-btn icon-stop" aria-label={t("pane.interrupt")} title={t("pane.interruptTitle")}
      onClick={() => { haptic(10); onStop(); }} />}
    <Button className="icon-btn icon-workspace" aria-label={t("workspace.open")} title={t("workspace.open")}
      onClick={onWorkspace} />
    <Button className="icon-btn icon-more" aria-label={t("pane.menuTitle")} disabled={state.operationBusy}
      onClick={onMenu} />
  </div>;
}

export function SessionChrome({ selected, includeBack, handlers }: {
  selected?: AgentCard; includeBack: boolean; handlers: SessionHandlers;
}) {
  const title = useRef<HTMLButtonElement>(null);
  const stale = herdLiveness() === "unverifiable";
  const status = selected ? (stale ? t("status.unverifiable") : statusLabel(selected.status)) : "";
  const fullLine = selected ? [status, agentMeta(selected)].filter(Boolean).join(" · ") : "";
  const meta = selected ? [status, cwdName(selected.cwd), tabIsSplit(selected, state.agents) ? t("chrome.split") : ""]
    .filter(Boolean).join(" · ") : "";
  const titleText = selected ? [agentTitle(selected), fullLine].filter(Boolean).join(" · ") : undefined;
  const aria = selected ? (fullLine ? t("chrome.switchAriaMeta", { title: agentTitle(selected), line: fullLine })
    : t("chrome.switchAria", { title: agentTitle(selected) })) : undefined;
  useLayoutEffect(() => {
    if (selected && morphingPane() === selected.paneId && title.current) shareTitle(title.current);
  });
  return <header className="chrome" data-react-session-chrome="">
    {includeBack && <BackButton onBack={handlers.onBack} label={t("chrome.backList")} />}
    <Button ref={title} className="chrome-title" title={titleText} aria-label={aria} onClick={handlers.onSwitch}>
      <span className="chrome-name">{selected ? chromeName(selected) : t("title.session")}</span>
      {meta && <span className="chrome-meta">
        <span className={`agent-dot agent-${stale ? "unknown" : selected!.status}`} />
        <span className="chrome-meta-text">{meta}</span>
      </span>}
    </Button>
    <SessionActions onWorkspace={handlers.onWorkspace} onMenu={handlers.onMenu}
      working={Boolean(selected && canInterruptAgent(selected.status))} onStop={() => queueKey("esc")} />
  </header>;
}
