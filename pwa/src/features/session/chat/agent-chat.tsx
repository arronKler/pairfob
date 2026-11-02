import { PromptProgressView } from "./prompt-progress-view";
import { ArrowDown } from "lucide-react";
import { openPaneId } from "../session-store";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { followTrace, setTraceFollow } from "./trace-store";
import { computersStore } from "../../computers/catalog-store";
import { useChat, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { t } from "../../../lib/i18n";
import { loadToolDetail, toolDetailView } from "./agent-chat-detail";
import { chatDockNotice, copyAgentReply, currentAgentTraceOwnerKey, emptySpec, jumpToLatest, leaveAgentChat,
  patchAgentChat, refreshAgentTrace, rememberAgentViewport, streamSig, visibleItems,
} from "./agent-chat-controller";
import { agentChatUIRevision, publishAgentChatUI, subscribeAgentChatUI } from "./agent-chat-ui";
import type { SessionHandlers } from "../guided/view";
import { commitView } from "../../../app/host";
import { agentFromDashboardSnapshot } from "../agents";
import { sessionOwner } from "../identity";
import { subscribeVisibleNotice, visibleNotice } from "../../../app/notices-store";
import { AgentCompose } from "./agent-compose";
import { AgentStream } from "./agent-stream";
import { olderRequestOf } from "./model";
import { capabilityEnabled } from "../../operations/capabilities-store";
import { Button, Feedback } from "../../../shared/ui/primitives";
import { SessionIdentity } from "../guided/session-chrome";

function AgentChatChrome({ includeBack, handlers }: { includeBack: boolean; handlers: SessionHandlers }) {
  const sessionSnap = useSession();
  const selected = agentFromDashboardSnapshot(useDashboard(), sessionSnap.paneId);
  return <SessionIdentity agent={selected} fallbackTitle={t("mode.agent")} includeBack={includeBack} handlers={handlers} />;
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
  const reading = useRef({ follow: chat.agentTraceFollow, unread: chat.agentTraceUnread });
  reading.current = { follow: chat.agentTraceFollow, unread: chat.agentTraceUnread };
  const paneId = sessionSnap.paneId;
  const working = agentFromDashboardSnapshot(useDashboard(), paneId)?.status === "working";
  const items = visibleItems();
  const hasOlder = olderRequestOf(chat, capabilityEnabled("agent_trace_sessions")) !== null;
  const earlier = [...chat.agentTraceOlder].reverse();
  const notice = chatDockNotice();
  const needDetail = useCallback((detailRef: string) => {
    if (!paneId) return;
    loadToolDetail(paneId, detailRef, () => { if (!patchAgentChat()) commitView(); });
  }, [paneId]);
  useLayoutEffect(() => {
    const element = stream.current;
    const ownerKey = currentAgentTraceOwnerKey();
    // Opening shows the latest message; a cached viewport never positions it.
    followTrace();
    if (element) element.scrollTop = element.scrollHeight;
    return () => {
      if (element) rememberAgentViewport(element, paneId, ownerKey, reading.current);
    };
  }, [paneId]);
  useEffect(() => {
    let retired = false;
    const session = computersStore.get().live;
    queueMicrotask(() => {
      if (!retired && computersStore.get().live === session && sessionSnap.paneId === paneId && sessionSnap.agentChat
        && !chat.agentTraceBusy && chat.agentTraceLoadState === "cold") void refreshAgentTrace();
    });
    return () => { retired = true; };
  }, [paneId, chat.agentTraceLoadState]);
  return <div className="pane-root agent-chat-root" data-react-agent-chat="" data-back={includeBack ? "1" : "0"}>
    <AgentChatChrome includeBack={includeBack} handlers={handlers} />
    {notice && <Feedback value={notice} appNotice />}
    <div className="agent-stream-wrap">
      <AgentStream streamRef={stream} items={items} earlier={earlier} working={working} empty={emptySpec(working)}
        busy={chat.agentTraceBusy || (!chat.agentTraceItems.length && chat.agentTraceLoadState === "cold")}
        signature={streamSig(items, working)} truncated={chat.agentTraceTruncated}
        onTerminal={() => { if (openPaneId() === paneId) leaveAgentChat(); }}
        onRetry={() => { if (!chat.agentTraceBusy) void refreshAgentTrace(); }}
        onNeedOlder={() => { if (hasOlder && !chat.agentTraceBusy) void refreshAgentTrace(true); }}
        onFollow={(follow, element) => {
          if (follow) followTrace();
          else setTraceFollow(false);
          publishAgentChatUI();
          rememberAgentViewport(element, paneId);
        }}
        onCopyReply={copyAgentReply} toolDetail={item => paneId && item.detailRef ? toolDetailView(paneId, item.detailRef) : { status: "ready" }}
        onNeedToolDetail={needDetail} older={<Button className="btn btn-small agent-older" hidden={!hasOlder}
          disabled={!hasOlder || chat.agentTraceBusy} onClick={() => {
            if (hasOlder && !chat.agentTraceBusy) void refreshAgentTrace(true);
          }}>{chat.agentTraceBusy && hasOlder ? t("chat.readingOlder") : t("hist.loadEarlier")}</Button>} />
      <Button className="agent-jump" hidden={chat.agentTraceFollow || !chat.agentTraceUnread} onClick={jumpToLatest}><ArrowDown size={16} aria-hidden="true" />{t("chat.newReply")}</Button>
    </div>
    <PromptProgressView />
    <AgentCompose />
  </div>;
}
