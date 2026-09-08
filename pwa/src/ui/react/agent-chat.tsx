import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { chromeName, statusLabel } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import { selectedAgent, state, subscribeNotice, visibleNotice } from "../../state";
import { canInterruptAgent } from "../chrome";
import { loadToolDetail, toolDetailView } from "../agent-chat-detail";
import { readDetailsState } from "../agent-chat-stream";
import { chatDockNotice, copyAgentReply, emptySpec, jumpToLatest, patchAgentChat, refreshAgentTrace,
  streamSig, visibleItems } from "../agent-chat-controller";
import { agentChatUIRevision, publishAgentChatUI, subscribeAgentChatUI } from "../agent-chat-ui";
import type { SessionHandlers } from "../session/view";
import { render } from "../../paint";
import { currentViewIncarnation } from "../../compose-drafts";
import { AgentCompose } from "./agent-compose";
import { AgentStream } from "./agent-stream";
import { BackButton, Button, Feedback } from "./chrome";
import { SessionActions } from "./session-chrome";

function AgentChatChrome({ includeBack, handlers }: { includeBack: boolean; handlers: SessionHandlers }) {
  const selected = selectedAgent();
  const title = selected ? chromeName(selected) : t("mode.agent");
  const line = selected ? statusLabel(selected.status) : "";
  const aria = selected ? (line ? t("chrome.switchAriaMeta", { title, line }) : t("chrome.switchAria", { title })) : undefined;
  return <header className="chrome">
    {includeBack && <BackButton onBack={handlers.onBack} label={t("chrome.backList")} />}
    <Button className="chrome-title" onClick={handlers.onSwitch} title={selected ? [title, line].filter(Boolean).join(" · ") : undefined} aria-label={aria}>
      <span className="chrome-name">{title}</span>
      {selected && <span className="chrome-meta"><span className={`agent-dot agent-${selected.status}`} /><span className="chrome-meta-text">{line}</span></span>}
    </Button>
    <SessionActions onWorkspace={handlers.onWorkspace} onMenu={handlers.onMenu}
      working={canInterruptAgent(selected?.status ?? "")} onStop={() => {
        const session = state.live;
        const paneId = state.paneId;
        if (session && paneId) void session.sendKeys(paneId, ["esc"], { intent: "pad" }).then(() => refreshAgentTrace());
      }} />
  </header>;
}

const sessionIds = new WeakMap<object, number>();
let nextSessionId = 0;
type AgentChatProps = { includeBack: boolean; handlers: SessionHandlers };

export function AgentChatPane(props: AgentChatProps) {
  const session = state.live;
  let sessionId = session ? sessionIds.get(session) : 0;
  if (session && sessionId === undefined) {
    sessionId = ++nextSessionId;
    sessionIds.set(session, sessionId);
  }
  return <AgentChatView key={`${sessionId}:${state.paneId}:${currentViewIncarnation()}`} {...props} />;
}

function AgentChatView({ includeBack, handlers }: AgentChatProps) {
  const stream = useRef<HTMLDivElement>(null);
  useSyncExternalStore(subscribeAgentChatUI, agentChatUIRevision);
  useSyncExternalStore(subscribeNotice, visibleNotice);
  const paneId = state.paneId;
  const working = selectedAgent()?.status === "working";
  const items = visibleItems();
  const notice = chatDockNotice();
  const kept = readDetailsState(stream.current);
  const needDetail = useCallback((detailRef: string) => {
    if (!paneId) return;
    loadToolDetail(paneId, detailRef, () => { if (!patchAgentChat()) render(); });
  }, [paneId]);
  useEffect(() => {
    let retired = false;
    const session = state.live;
    queueMicrotask(() => {
      if (!retired && state.live === session && state.paneId === paneId && state.agentChat
        && !state.agentTraceBusy && state.agentTraceLoadState === "cold") void refreshAgentTrace();
    });
    return () => { retired = true; };
  }, [paneId]);
  return <div className="pane-root agent-chat-root" data-react-agent-chat="" data-back={includeBack ? "1" : "0"}>
    <AgentChatChrome includeBack={includeBack} handlers={handlers} />
    {notice && <Feedback value={notice} appNotice />}
    <div className="agent-stream-wrap">
      <AgentStream streamRef={stream} items={items} working={working} empty={emptySpec(working)}
        busy={state.agentTraceBusy || (!state.agentTraceItems.length && state.agentTraceLoadState === "cold")}
        kept={kept} signature={streamSig(items, working)} truncated={state.agentTraceTruncated}
        onRetry={() => { if (!state.agentTraceBusy) void refreshAgentTrace(); }}
        onNeedOlder={() => { if (state.agentTraceNext && !state.agentTraceBusy) void refreshAgentTrace(true); }}
        onFollow={follow => { if (follow) state.agentTraceUnread = false; publishAgentChatUI(); }}
        onCopyReply={copyAgentReply} toolDetail={item => paneId && item.detailRef ? toolDetailView(paneId, item.detailRef) : { status: "ready" }}
        onNeedToolDetail={needDetail} older={<Button className="btn btn-small agent-older" hidden={!state.agentTraceNext}
          disabled={!state.agentTraceNext || state.agentTraceBusy} onClick={() => {
            if (state.agentTraceNext && !state.agentTraceBusy) void refreshAgentTrace(true);
          }}>{state.agentTraceBusy && state.agentTraceNext ? t("chat.readingOlder") : t("hist.loadEarlier")}</Button>} />
      <Button className="agent-jump" hidden={state.agentTraceFollow || !state.agentTraceUnread} onClick={jumpToLatest}>{t("chat.newReply")}</Button>
    </div>
    <AgentCompose />
  </div>;
}
