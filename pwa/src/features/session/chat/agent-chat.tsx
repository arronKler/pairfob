import { PromptProgressView, usePromptProgressNote } from "./prompt-progress-view";
import { ArrowDown } from "lucide-react";
import { isAgentChat, openPaneId } from "../session-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { followTrace, setTraceFollow } from "./trace-store";
import { glidingToTail, pinTail, subscribeTailGlide } from "./tail-glide";
import { computersStore } from "../../computers/catalog-store";
import { useAgentCard, useChat, usePaneId } from "../hooks";
import { t } from "../../../lib/i18n";
import { capabilityEnabled } from "../../operations/capabilities-store";
import { useStatusUnverifiable } from "../guided/session-chrome";
import { openStepSheet } from "./step-sheet";
import { chatTraceNote, copyAgentReply, currentAgentTraceOwnerKey, emptySpec, jumpToLatest, leaveAgentChat,
  refreshAgentTrace, rememberAgentPosture, rememberAgentViewport, restoreAgentViewport, streamSig, visibleItems,
} from "./agent-chat-controller";
import { agentChatUIRevision, publishAgentChatUI, subscribeAgentChatUI } from "./agent-chat-ui";
import type { SessionHandlers } from "../guided/view";
import type { AgentTraceItem } from "../../../lib/operations";
import { recordsStepResults, turnStepRows, type TurnRef } from "../../../lib/agent-trace-steps";
import { sessionOwner } from "../identity";
import { subscribeVisibleNotice, visibleNotice } from "../../../app/notices-store";
import { AgentCompose } from "./agent-compose";
import { AgentStream } from "./agent-stream";
import { beforeChatReadingChange, restoreStreamAnchor, streamAnchor, useChatPinch, useDrawnChatSize,
  type StreamAnchor } from "./chat-reading";
import { ChatReadingButton } from "./chat-reading-tools";
import { usePresence } from "../../../shared/react/use-presence";
import { MOTION_MS } from "../../../shared/ui/dom/motion";
import { Button } from "../../../shared/ui/primitives";
import { noticeKeepsItsPlace, SessionNotice } from "../session-notice";
import { SessionIdentity } from "../guided/session-chrome";

function AgentChatChrome({ includeBack, handlers, follow }: { includeBack: boolean; handlers: SessionHandlers; follow: boolean }) {
  const selected = useAgentCard(usePaneId());
  // A peek brings the header back while the reader stays up in the transcript;
  // reaching the tail again hands it back to the scroll posture.
  const [peeked, setPeeked] = useState(false);
  if (follow && peeked) setPeeked(false);
  const collapsed = !follow && !peeked;
  return <div className="chrome agent-chrome" data-collapsed={collapsed ? "1" : undefined}>
    <div className="agent-chrome-inner" inert={collapsed} aria-hidden={collapsed ? "true" : undefined}>
      <SessionIdentity agent={selected} fallbackTitle={t("mode.agent")} includeBack={includeBack} handlers={handlers}
        reading={<ChatReadingButton />} />
    </div>
    <Button className="agent-peek" aria-label={t("chat.showHeader")} tabIndex={collapsed ? 0 : -1}
      aria-hidden={collapsed ? undefined : "true"} inert={!collapsed} onClick={() => setPeeked(true)}>
      <span className="agent-peek-handle" aria-hidden="true" />
    </Button>
  </div>;
}

type AgentChatProps = { includeBack: boolean; handlers: SessionHandlers };

export function AgentChatPane(props: AgentChatProps) {
  return <AgentChatView key={sessionOwner().key} {...props} />;
}

function AgentChatView({ includeBack, handlers }: AgentChatProps) {
  const stream = useRef<HTMLDivElement>(null);
  useSyncExternalStore(subscribeAgentChatUI, agentChatUIRevision);
  useSyncExternalStore(subscribeVisibleNotice, visibleNotice);
  const paneId = usePaneId();
  const chat = useChat();
  const readGlide = useCallback(() => glidingToTail(stream.current), []);
  const gliding = useSyncExternalStore(subscribeTailGlide, readGlide, () => false);
  // The header's step-aside changes the stream's box. A glide measures its
  // travel against that box, so it keeps the place the header had until the
  // reader is back at the tail; only then does the header return.
  const headerFollow = useRef(chat.agentTraceFollow);
  if (!gliding) headerFollow.current = chat.agentTraceFollow;
  const reading = useRef({ follow: chat.agentTraceFollow, unread: chat.agentTraceUnread });
  reading.current = { follow: chat.agentTraceFollow, unread: chat.agentTraceUnread };
  // The transcript's size belongs to this device: a mouse reads at 14, a
  // finger at 16, and two fingers on the transcript walk the steps.
  const readingSize = useDrawnChatSize();
  const heldPlace = useRef<StreamAnchor | null>(null);
  useEffect(() => beforeChatReadingChange(() => {
    heldPlace.current = stream.current ? streamAnchor(stream.current) : null;
  }), []);
  useChatPinch(stream);
  // A size change redraws every line: the turn being read keeps its place, and
  // at the tail the newest turn stays against the dock.
  useLayoutEffect(() => {
    const element = stream.current;
    const held = heldPlace.current;
    heldPlace.current = null;
    if (!element) return;
    if (reading.current.follow) element.scrollTop = element.scrollHeight;
    else if (held) restoreStreamAnchor(element, held);
  }, [readingSize]);
  const agent = useAgentCard(paneId);
  const status = agent?.status;
  // A blocked agent is still inside its turn: the card stays live and says it waits on you.
  const working = status === "working" || status === "blocked";
  const stale = useStatusUnverifiable();
  // trace_labels comes with real Claude/Codex failure states; before it, "done" only means "ended".
  const verified = capabilityEnabled("trace_labels") && recordsStepResults(agent?.agent);
  const progress = usePromptProgressNote();
  // The transcript is the only array this screen renders: a repaint for the
  // reading posture, a notice or a status must not rebuild it.
  const items = useMemo(() => visibleItems(), [chat.agentTraceItems, chat.agentTracePending]);
  // What stays keeps its place in the page: an error raised to stay, else the chat's own note about its
  // history. A passing notice floats under it, so the note it used to replace does not leave and come back.
  const appNotice = visibleNotice();
  const passing = appNotice && !noticeKeepsItsPlace(appNotice) ? appNotice : null;
  const standing = appNotice && !passing ? appNotice : chatTraceNote();
  // Steps that arrived since the reader scrolled away, for the jump button.
  const seen = useRef(items.length);
  if (chat.agentTraceFollow) seen.current = items.length;
  const newSteps = items.slice(Math.min(seen.current, items.length)).filter((item) => item.type === "tool").length;
  // The chip leaves with the scroll it started (`.term-jump-out`), saying what it said when pressed.
  const jumpShown = !chat.agentTraceFollow && chat.agentTraceUnread;
  const jump = usePresence(jumpShown, MOTION_MS.press);
  const jumpLabel = useRef("");
  if (jumpShown) jumpLabel.current = working && newSteps ? t("chat.newSteps", { n: newSteps }) : t(working ? "chat.newProgress" : "chat.newReply");
  const openStep = useCallback((item: AgentTraceItem, steps: AgentTraceItem[], turn: TurnRef) => {
    // The sheet re-finds its turn on every trace update, so running steps finish in place.
    // The sheet re-finds its rows in the same list the card draws, so its index stays true.
    if (paneId) openStepSheet(paneId, item, verified, steps, () => turnStepRows(visibleItems(), turn));
  }, [paneId, verified]);
  // Stable identities: a turn only redraws when its own content changed.
  const openTerminal = useCallback(() => { if (openPaneId() === paneId) leaveAgentChat(); }, [paneId]);
  const answered = useCallback(() => { void refreshAgentTrace(); }, []);
  useLayoutEffect(() => {
    const element = stream.current;
    const ownerKey = currentAgentTraceOwnerKey();
    // No saved place means a fresh visit: it starts at the latest turn.
    if (element && !restoreAgentViewport(element, paneId, ownerKey) && reading.current.follow) element.scrollTop = element.scrollHeight;
    return () => rememberAgentPosture(paneId, ownerKey, reading.current);
  }, [paneId]);
  useLayoutEffect(() => {
    const element = stream.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!element || !Observer) return;
    // The header's step-aside changes the stream's box while the reader stays
    // at the tail; keep the latest turn against the dock as it grows back.
    const observer = new Observer(() => { if (reading.current.follow) pinTail(element); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let retired = false;
    const session = computersStore.get().live;
    queueMicrotask(() => {
      if (!retired && computersStore.get().live === session && openPaneId() === paneId && isAgentChat()
        && !chat.agentTraceBusy && chat.agentTraceLoadState === "cold") void refreshAgentTrace();
    });
    return () => { retired = true; };
  }, [paneId, chat.agentTraceLoadState]);
  return <div className="pane-root agent-chat-root" data-react-agent-chat="" data-back={includeBack ? "1" : "0"}
    style={{ "--chat-fs": `${readingSize}px` } as CSSProperties}>
    <AgentChatChrome includeBack={includeBack} handlers={handlers} follow={gliding ? headerFollow.current : chat.agentTraceFollow} />
    <SessionNotice value={standing} inPage />
    <SessionNotice value={passing} />
    <div className="agent-stream-wrap">
      <AgentStream streamRef={stream} items={items} working={working} waiting={status === "blocked"} stale={stale}
        verified={verified} progress={progress} follow={chat.agentTraceFollow} hasOlder={chat.agentTraceNext !== null}
        historyLoads={chat.agentTraceOlder}
        empty={emptySpec(working)}
        busy={chat.agentTraceBusy || (!chat.agentTraceItems.length && chat.agentTraceLoadState === "cold")}
        signature={streamSig(items, working)} truncated={chat.agentTraceTruncated}
        onTerminal={openTerminal}
        onRetry={() => { if (!chat.agentTraceBusy) void refreshAgentTrace(); }}
        onNeedOlder={() => { if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true); }}
        onFollow={(follow, element) => {
          // A glide to the tail passes through "not at the tail" on its way; the reader has not left.
          // A scroll that changes neither the follow nor the unread posture repaints nothing: the
          // event fires per frame, and the transcript cache already carries the place.
          if (follow || glidingToTail(element)) {
            if (followTrace()) publishAgentChatUI();
          } else if (setTraceFollow(false)) {
            publishAgentChatUI();
          }
          rememberAgentViewport(element, paneId);
        }}
        onCopyReply={copyAgentReply} onOpenStep={openStep} onAnswered={answered} older={<Button className="btn btn-small agent-older" hidden={!chat.agentTraceNext}
          disabled={!chat.agentTraceNext || chat.agentTraceBusy} onClick={() => {
            if (chat.agentTraceNext && !chat.agentTraceBusy) void refreshAgentTrace(true);
          }}>{chat.agentTraceBusy && chat.agentTraceNext ? t("chat.readingOlder") : t("hist.loadEarlier")}</Button>} />
      <Button className={jump.leaving ? "agent-jump term-jump-out" : "agent-jump"} hidden={!jump.mounted} inert={jump.leaving} onClick={jumpToLatest}><ArrowDown size={16} aria-hidden="true" />{jumpLabel.current}</Button>
    </div>
    <PromptProgressView note={progress} pending={chat.agentTracePending} />
    <AgentCompose />
  </div>;
}
