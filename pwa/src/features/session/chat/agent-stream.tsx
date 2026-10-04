import { useLayoutEffect, useRef, type MouseEvent, type ReactNode, type Ref } from "react";
import { renderMarkdown } from "../../../lib/agent-markdown";
import { groupAgentTurns, replyText, turnKey, type AgentTurn } from "../../../lib/agent-trace-view";
import { pendingAsk, splitTurn, stepObject, turnOutcome, turnSpan, type TurnRef } from "../../../lib/agent-trace-steps";
import type { AgentTraceItem } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import type { AgentEmptySpec, DetailsState } from "./agent-chat-stream";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { CompactionDivider, PendingCard, ReplyActions, TurnHead, type TraceAnchorData } from "./turn-parts";
import { NeedsYouCard } from "./needs-you";
import { WorkCard } from "./work-card";

type CopyReply = (text: string, what?: "reply" | "code") => void | Promise<void>;

/**
 * Give each code block in a sanitized reply its own copy button. The reply's
 * HTML is not React-managed, so the buttons are added after it is set and
 * handled by one delegated click.
 */
function useCodeCopy(html: string, onCopy?: CopyReply) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !onCopy) return;
    for (const pre of node.querySelectorAll("pre")) {
      if (pre.parentElement?.classList.contains("md-code")) continue;
      const frame = node.ownerDocument.createElement("div");
      frame.className = "md-code";
      const button = node.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "md-copy";
      button.textContent = t("reply.copyCode");
      pre.replaceWith(frame);
      frame.append(pre, button);
    }
  }, [html, onCopy]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element).closest?.(".md-copy");
    const code = button?.parentElement?.querySelector("pre");
    if (button && code && onCopy) void onCopy(code.textContent ?? "", "code");
  };
  return { root, onClick };
}
type TraceAnchor = { key: string; ordinal: number; ordinalFromEnd: number };
/** A step tapped in a card: the card's steps and where to find the turn again. */
export type OpenStep = (item: AgentTraceItem, steps: AgentTraceItem[], turn: TurnRef) => void;
export type PromptProgressNote = { message: string; attention: boolean; settled: boolean };

function anchorData(anchor: TraceAnchor, part: string): TraceAnchorData {
  return {
    "data-trace-anchor": `${anchor.key}:${part}`,
    "data-trace-ordinal": anchor.ordinal,
    "data-trace-ordinal-end": anchor.ordinalFromEnd,
  };
}

function AssistantReply({ items, final, anchor, part, onCopy }: {
  items: AgentTraceItem[]; final: boolean; anchor: TraceAnchor; part: string; onCopy?: CopyReply;
}) {
  const text = replyText(items);
  const html = renderMarkdown(text);
  const code = useCodeCopy(html, final ? onCopy : undefined);
  return <article {...anchorData(anchor, part)} className={`agent-assistant${final ? " agent-assistant-final" : " agent-assistant-intermediate"}`}>
    {/* The existing Markdown parser returns sanitized allowlisted HTML. */}
    <div ref={code.root} className="agent-md" onClick={code.onClick} dangerouslySetInnerHTML={{ __html: html }} />
    {final && <ReplyActions text={text} onCopy={onCopy} />}
  </article>;
}


/**
 * The card's saved open/closed choice key. Repeated prompts share a turn key,
 * so the first tool tells their cards apart when older history is prepended.
 */
function workKey(turn: AgentTurn): string {
  const tool = turn.items.find((item) => item.type === "tool");
  const signature = tool ? `${tool.name || ""}:${(tool.label || tool.input || "").slice(0, 24)}` : "";
  return `w:${turnKey(turn)}:${signature}`;
}

type TurnState = {
  live: boolean; waiting: boolean; stale: boolean; verified: boolean; pending?: PromptProgressNote;
  /** Another turn follows; partial: older pages hold this turn's start. */
  hasNext: boolean; partial: boolean; follow: boolean;
};

function TraceTurn({ turn, state, anchor, kept, onCopy, onTerminal, onAnswered, onOpenStep }: {
  turn: AgentTurn; state: TurnState; anchor: TraceAnchor; kept?: DetailsState; onCopy?: CopyReply; onTerminal?: () => void;
  onAnswered?: () => void; onOpenStep: OpenStep;
}) {
  const { entries, reply, compacted, interrupted } = splitTurn(turn);
  const { live, waiting } = state;
  const outcome = turnOutcome(turn.items, state);
  const tools = entries.filter((item) => item.type === "tool");
  // A turn that stopped on a failed step already names it.
  if (!live && !reply.length && tools.length && !interrupted && outcome.tone !== "error") {
    // A message sent mid-run starts a new turn; the work goes on there.
    outcome.detail = state.hasNext ? t("work.continued") : t("work.noReply", { step: stepObject(tools[tools.length - 1]) });
  }
  if (state.partial) outcome.detail = [t("work.partial"), outcome.detail].filter(Boolean).join(" · ");
  const card = entries.length > 0 || interrupted || (live && !state.pending);
  return <>
    {turn.user && <TurnHead item={turn.user} anchorData={anchorData(anchor, "user")} />}
    {state.pending && !turn.items.length && <PendingCard {...state.pending} />}
    {card && <WorkCard traceKey={workKey(turn)} entries={entries} outcome={outcome} live={live} follow={state.follow} kept={kept}
      verified={state.verified} span={turnSpan(turn.user, turn.items)}
      onOpen={(item, steps) => onOpenStep(item, steps, { key: anchor.key, ordinal: anchor.ordinal })}
      anchor={{ anchor: `${anchor.key}:work`, ordinal: anchor.ordinal, ordinalFromEnd: anchor.ordinalFromEnd }} />}
    {live && waiting && <NeedsYouCard ask={pendingAsk(turn.items)} onTerminal={onTerminal} onAnswered={onAnswered} />}
    {reply.length > 0 && <AssistantReply items={reply} final={!live} anchor={anchor} part="reply" onCopy={onCopy} />}
    {compacted && <CompactionDivider />}
  </>;
}

function EmptyPanel({ spec, onRetry, onTerminal }: { spec: AgentEmptySpec; onRetry?: () => void; onTerminal?: () => void }) {
  return <div className={`agent-empty agent-empty-${spec.kind}`} role={spec.kind === "error" ? "alert" : "status"}>
    {(spec.kind === "loading" || spec.kind === "working") && <Spinner />}
    <p className="agent-empty-title">{spec.title}</p>
    {spec.sub && <p className="agent-empty-sub">{spec.sub}</p>}
    {spec.kind === "unavailable" && onTerminal && <Button className="btn btn-small agent-open-terminal" onClick={onTerminal}>{t("chat.openTerminal")}</Button>}
    {spec.kind === "error" && onRetry && <Button className="btn btn-small" onClick={onRetry}>{t("retry")}</Button>}
  </div>;
}

function turnAnchor(turn: AgentTurn, index: number, turns: readonly AgentTurn[]): TraceAnchor {
  const key = turnKey(turn);
  let ordinal = 0;
  let ordinalFromEnd = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (turnKey(turns[cursor]) === key) ordinal += 1;
  }
  for (let cursor = index + 1; cursor < turns.length; cursor += 1) {
    if (turnKey(turns[cursor]) === key) ordinalFromEnd += 1;
  }
  return { key, ordinal, ordinalFromEnd };
}

export function AgentStream({ items, working, waiting = false, stale = false, verified = false, follow = true, hasOlder = false,
  progress, empty, busy, kept,
  onRetry, onTerminal, onAnswered, onNeedOlder, onFollow, onCopyReply, onOpenStep, truncated, older, streamRef, signature }: {
  items: AgentTraceItem[]; working: boolean; waiting?: boolean; stale?: boolean; verified?: boolean; progress?: PromptProgressNote | null;
  follow?: boolean; hasOlder?: boolean;
  empty: AgentEmptySpec; busy?: boolean; kept?: DetailsState;
  onRetry?: () => void; onTerminal?: () => void; onAnswered?: () => void; onNeedOlder?: () => void; onFollow?: (follow: boolean, stream: HTMLElement) => void;
  onCopyReply?: CopyReply; onOpenStep?: OpenStep; truncated?: boolean;
  older?: ReactNode; streamRef?: Ref<HTMLDivElement>; signature?: string;
}) {
  const turns = groupAgentTurns(items);
  const openStep = onOpenStep ?? (() => undefined);
  return <div ref={streamRef} className="agent-stream" role="log" aria-label={t("chat.streamAria")}
    aria-busy={busy === true} tabIndex={0} data-sig={signature} onScroll={event => {
      const stream = event.currentTarget;
      const follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 32;
      onFollow?.(follow, stream);
      if (stream.scrollTop < 32) onNeedOlder?.();
    }}>
    <div className="agent-stream-inner">
      {older}
      {(!items.length || empty.kind === "unavailable") && <EmptyPanel spec={empty} onRetry={onRetry} onTerminal={onTerminal} />}
      {truncated && items.length > 0 && <p className="agent-trace-limit">{t("chat.truncated")}</p>}
      {/* Claude Code's /clear opens a new transcript: nothing older belongs to it. */}
      {!hasOlder && turns[0]?.user?.type === "command" && /^\/clear\b/.test(turns[0].user.text || "")
        && <div className="agent-marker agent-marker-compaction agent-new-session" role="note"><span>{t("chat.newSession")}</span></div>}
      {turns.map((turn, index) => {
        const last = index === turns.length - 1;
        const live = working && empty.kind !== "unavailable" && last && turn.items.at(-1)?.type !== "interrupt";
        const pending = turn.user?.pending && progress ? progress : undefined;
        return <TraceTurn key={`${turnKey(turn)}:${index}`} turn={turn} anchor={turnAnchor(turn, index, turns)}
          state={{ live, waiting: waiting && last, stale, verified, pending, follow,
            hasNext: !last, partial: index === 0 && hasOlder && !turn.user }}
          kept={kept} onCopy={onCopyReply} onTerminal={onTerminal} onAnswered={onAnswered} onOpenStep={openStep} />;
      })}
    </div>
  </div>;
}
