import { PromptProgressView, usePromptProgressNote } from "./prompt-progress-view";
import { ArrowDown } from "lucide-react";
import { openPaneId } from "../session-store";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { followTrace, setTraceFollow } from "./trace-store";
import { computersStore } from "../../computers/catalog-store";
import { useChat, useSession } from "../hooks";
import { useDashboard } from "../../dashboard/hooks";
import { t } from "../../../lib/i18n";
import { capabilityEnabled } from "../../operations/capabilities-store";
import { useStatusUnverifiable } from "../guided/session-chrome";
import { openStepSheet } from "./step-sheet";
import { chatDockNotice, copyAgentReply, currentAgentTraceOwnerKey, emptySpec, jumpToLatest, leaveAgentChat,
  refreshAgentTrace, rememberAgentPosture, rememberAgentViewport, restoreAgentViewport, streamSig, visibleItems,
} from "./agent-chat-controller";
import { agentChatUIRevision, publishAgentChatUI, subscribeAgentChatUI } from "./agent-chat-ui";
import type { SessionHandlers } from "../guided/view";
import type { AgentTraceItem } from "../../../lib/operations";
import { turnEntries, type TurnRef } from "../../../lib/agent-trace-steps";
import { agentFromDashboardSnapshot } from "../agents";
import { sessionOwner } from "../identity";
import { subscribeVisibleNotice, visibleNotice } from "../../../app/notices-store";
import { AgentCompose } from "./agent-compose";
import { AgentStream } from "./agent-stream";
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
  const status = agentFromDashboardSnapshot(useDashboard(), paneId)?.status;
  // A blocked agent is still inside its turn: the card stays live and says it waits on you.
  const working = status === "working" || status === "blocked";
  const stale = useStatusUnverifiable();
  // trace_labels comes with real Claude/Codex failure states; before it, "done" only means "ended".
  const verified = capabilityEnabled("trace_labels");
  const progress = usePromptProgressNote();
  const items = visibleItems();
  const notice = chatDockNotice();
  // Steps that arrived since the reader scrolled away, for the jump button.
  const seen = useRef(items.length);
  if (chat.agentTraceFollow) seen.current = items.length;
  const newSteps = items.slice(Math.min(seen.current, items.length)).filter((item) => item.type === "tool").length;
  const openStep = useCallback((item: AgentTraceItem, steps: AgentTraceItem[], turn: TurnRef) => {
    // The sheet re-finds its turn on every trace update, so running steps finish in place.
    if (paneId) openStepSheet(paneId, item, verified, steps, () => turnEntries(visibleItems(), turn));
  }, [paneId, verified]);
  useLayoutEffect(() => {
    const element = stream.current;
    const ownerKey = currentAgentTraceOwnerKey();
    // No saved place means a fresh visit: it starts at the latest turn.
    if (element && !restoreAgentViewport(element, paneId, ownerKey) && reading.current.follow) element.scrollTop = element.scrollHeight;
    return () => rememberAgentPosture(paneId, ownerKey, reading.current);
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
      <AgentStream streamRef={stream} items={items} working={working} waiting={status === "blocked"} stale={stale}
        verified={verified} progress={progress} follow={chat.agentTraceFollow} hasOlder={chat.agentTraceNext !== null}
        empty={emptySpec(working)}
        busy={chat.agentTraceBusy || (!chat.agentTraceItems.length && chat.agentTraceLoadState === "cold")}
        signature={streamSig(items, working)} truncated={chat.agentTraceTruncated}
        onTerminal={() => { if (openPaneId() === paneId) leaveAgentChat(); }}
        onRetry={() => { if (!chat.agentTraceBusy) void refreshAgentTrace(); }}
        onNeedOlder={() => { if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true); }}
        onFollow={(follow, element) => {
          if (follow) followTrace();
          else setTraceFollow(false);
          publishAgentChatUI();
          rememberAgentViewport(element, paneId);
        }}
        onCopyReply={copyAgentReply} onOpenStep={openStep} onAnswered={() => void refreshAgentTrace()} older={<Button className="btn btn-small agent-older" hidden={!chat.agentTraceNext}
          disabled={!chat.agentTraceNext || chat.agentTraceBusy} onClick={() => {
            if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true);
          }}>{chat.agentTraceBusy && chat.agentTraceNext ? t("chat.readingOlder") : t("hist.loadEarlier")}</Button>} />
      <Button className="agent-jump" hidden={chat.agentTraceFollow || !chat.agentTraceUnread} onClick={jumpToLatest}><ArrowDown size={16} aria-hidden="true" />{working && newSteps ? t("chat.newSteps", { n: newSteps })
        : t(working ? "chat.newProgress" : "chat.newReply")}</Button>
    </div>
    <PromptProgressView />
    <AgentCompose />
  </div>;
}
