import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { followTrace, setTraceFollow } from "./trace-store";
import { computersStore } from "../../computers/catalog-store";
import { useChat, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { chromeName, statusLabel } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import { canInterruptAgent } from "../../connection/runtime-status";
import { loadToolDetail, toolDetailView } from "./agent-chat-detail";
import { chatDockNotice, copyAgentReply, emptySpec, jumpToLatest, patchAgentChat, refreshAgentTrace,
  streamSig, visibleItems } from "./agent-chat-controller";
import { agentChatUIRevision, publishAgentChatUI, subscribeAgentChatUI } from "./agent-chat-ui";
import type { SessionHandlers } from "../guided/view";
import { commitView } from "../../../app/host";
import { agentFromDashboardSnapshot } from "../agents";
import { sessionOwner } from "../identity";
import { subscribeVisibleNotice, visibleNotice } from "../../../app/notices-store";
import { AgentCompose } from "./agent-compose";
import { AgentStream } from "./agent-stream";
import { BackButton, Button, Feedback } from "../../../shared/ui/primitives";
import { SessionActions } from "../guided/session-chrome";

function AgentChatChrome({ includeBack, handlers }: { includeBack: boolean; handlers: SessionHandlers }) {
  const sessionSnap = useSession();
  const selected = agentFromDashboardSnapshot(useDashboard(), sessionSnap.paneId);
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
        const session = computersStore.get().live;
        const paneId = sessionSnap.paneId;
        if (session && paneId) void session.sendKeys(paneId, ["esc"], { intent: "pad" }).then(() => refreshAgentTrace());
      }} />
  </header>;
}

type AgentChatProps = { includeBack: boolean; handlers: SessionHandlers };

export function AgentChatPane(props: AgentChatProps) {
  return <AgentChatView key={sessionOwner().key} {...props} />;
}

function AgentChatView({ includeBack, handlers }: AgentChatProps) {
  const stream = useRef<HTMLDivElement>(null);
  useSyncExternalStore(subscribeAgentChatUI, agentChatUIRevision);
  useSyncExternalStore(subscribeVisibleNotice, visibleNotice);
  const sessionSnap = useSession();
  const chat = useChat();
  const paneId = sessionSnap.paneId;
  const working = agentFromDashboardSnapshot(useDashboard(), paneId)?.status === "working";
  const items = visibleItems();
  const notice = chatDockNotice();
  const needDetail = useCallback((detailRef: string) => {
    if (!paneId) return;
    loadToolDetail(paneId, detailRef, () => { if (!patchAgentChat()) commitView(); });
  }, [paneId]);
  useEffect(() => {
    let retired = false;
    const session = computersStore.get().live;
    queueMicrotask(() => {
      if (!retired && computersStore.get().live === session && sessionSnap.paneId === paneId && sessionSnap.agentChat
        && !chat.agentTraceBusy && chat.agentTraceLoadState === "cold") void refreshAgentTrace();
    });
    return () => { retired = true; };
  }, [paneId]);
  return <div className="pane-root agent-chat-root" data-react-agent-chat="" data-back={includeBack ? "1" : "0"}>
    <AgentChatChrome includeBack={includeBack} handlers={handlers} />
    {notice && <Feedback value={notice} appNotice />}
    <div className="agent-stream-wrap">
      <AgentStream streamRef={stream} items={items} working={working} empty={emptySpec(working)}
        busy={chat.agentTraceBusy || (!chat.agentTraceItems.length && chat.agentTraceLoadState === "cold")}
        signature={streamSig(items, working)} truncated={chat.agentTraceTruncated}
        onRetry={() => { if (!chat.agentTraceBusy) void refreshAgentTrace(); }}
        onNeedOlder={() => { if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true); }}
        onFollow={follow => {
          if (follow) followTrace();
          else setTraceFollow(false);
          publishAgentChatUI();
        }}
        onCopyReply={copyAgentReply} toolDetail={item => paneId && item.detailRef ? toolDetailView(paneId, item.detailRef) : { status: "ready" }}
        onNeedToolDetail={needDetail} older={<Button className="btn btn-small agent-older" hidden={!chat.agentTraceNext}
          disabled={!chat.agentTraceNext || chat.agentTraceBusy} onClick={() => {
            if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true);
          }}>{chat.agentTraceBusy && chat.agentTraceNext ? t("chat.readingOlder") : t("hist.loadEarlier")}</Button>} />
      <Button className="agent-jump" hidden={chat.agentTraceFollow || !chat.agentTraceUnread} onClick={jumpToLatest}>{t("chat.newReply")}</Button>
    </div>
    <AgentCompose />
  </div>;
}
