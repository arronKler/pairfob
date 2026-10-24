import { captureFileLinkOwner, openChatFile } from "../../workspace/file-links";
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { renderMarkdown } from "../../../lib/agent-markdown";
import { groupAgentTurns, replyText, submittedText, turnKey, type AgentTurn } from "../../../lib/agent-trace-view";
import { findingBreaks, pendingAsk, splitTurn, stepObject, stepRows, turnOutcome, turnSpan, type TurnRef } from "../../../lib/agent-trace-steps";
import type { AgentTraceItem } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import type { AgentEmptySpec, DetailsState } from "./agent-chat-stream";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { CompactionDivider, PendingCard, ReplyActions, TurnHead, type TraceAnchorData } from "./turn-parts";
import { NeedsYouCard } from "./needs-you";
import { turnModels } from "./turn-models";
import { WorkCard } from "./work-card";
import { confirmCopyOn, layCopyFaces } from "../copy-confirm";
import { useTurned } from "./use-turned";

/** Copies `text`; resolves true once it is on the clipboard, so the pressed button can say so. */
type CopyReply = (text: string, what?: "reply" | "code") => unknown;

/** A code block as it is copied: the line break that ends the block is not code, and pasted into a shell it would run the line. */
export function copiedCode(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/**
 * Where each block's copy button stands. A block of one line that fits beside
 * the button is a single row with the button at its end, and the line stops
 * short of it. Every other block (several lines, or one line longer than that
 * room) keeps a strip above its first line for the button, so the button never
 * covers code and a short block is not a tall one.
 */
function layCodeBlocks(node: HTMLElement): void {
  for (const frame of node.querySelectorAll<HTMLElement>(".md-code")) {
    const pre = frame.querySelector("pre");
    const button = frame.querySelector<HTMLElement>(".md-copy");
    if (!pre || !button) continue;
    const oneLine = !copiedCode(pre.textContent ?? "").includes("\n");
    frame.classList.toggle("is-inline", oneLine);
    if (!oneLine) continue;
    frame.style.setProperty("--md-copy-w", `${button.offsetWidth}px`);
    // Measured in the one-row form: a line that scrolls there has no room beside the button.
    if (pre.scrollWidth > pre.clientWidth + 1) frame.classList.remove("is-inline");
  }
}

/**
 * Give each code block in a sanitized reply its own copy button. The reply's
 * HTML is not React-managed, so the buttons are added after it is set and
 * handled by one delegated click.
 *
 * `markup` is the object to hand React, the same one for the same HTML. React
 * writes `innerHTML` again whenever that object is a new one, not when the
 * string in it changes: a fresh `{ __html }` on every render threw the buttons
 * away on the first re-render after they were added (and with them whatever
 * the reader had selected in the reply), and nothing put them back.
 */
function useCodeCopy(html: string, onCopy?: CopyReply) {
  const root = useRef<HTMLDivElement>(null);
  const markup = useMemo(() => ({ __html: html }), [html]);
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
      layCopyFaces(button, t("reply.copyCode"), t("reply.copied"));
      pre.replaceWith(frame);
      frame.append(pre, button);
    }
    layCodeBlocks(node);
    // The room beside the button follows the reply's width: a turned phone, the inspector opening.
    const Observer = node.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    let width = node.clientWidth;
    const observer = new Observer(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      layCodeBlocks(node);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [markup, onCopy]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element).closest?.<HTMLElement>(".md-copy");
    const code = button?.parentElement?.querySelector("pre");
    if (!button || !code || !onCopy) return;
    void Promise.resolve(onCopy(copiedCode(code.textContent ?? ""), "code")).then((copied) => {
      if (copied === true && button.isConnected) confirmCopyOn(button, t("reply.copyCode"), t("reply.copied"), t("chat.copiedCode"));
    });
  };
  return { root, markup, onClick };
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
  const [fileOwner] = useState(captureFileLinkOwner);
  const text = replyText(items);
  const html = renderMarkdown(text, true);
  const code = useCodeCopy(html, final ? onCopy : undefined);
  // The turn ended on this reply: its actions come in after the card above has folded.
  const finished = useTurned(final);
  // A record can carry an empty text (an agent that only called tools, or a
  // placeholder the daemon later replaced). Drawing it would leave a blank,
  // focusable bubble with nothing in it.
  if (!text.trim()) return null;
  return <article {...anchorData(anchor, part)} className={`agent-assistant${final ? " agent-assistant-final" : " agent-assistant-intermediate"}`}>
    {/* The existing Markdown parser returns sanitized allowlisted HTML. */}
    <div ref={code.root} className="agent-md" onClick={event => {
      const link = (event.target as Element).closest?.('a[data-file-ref]');
      if (link && event.currentTarget.contains(link)) {
        event.preventDefault();
        void openChatFile(link.getAttribute('data-file-ref')!, fileOwner);
      } else code.onClick(event);
    }} dangerouslySetInnerHTML={code.markup} />
    {final && <ReplyActions text={text} onCopy={onCopy} arriving={finished} />}
  </article>;
}

/**
 * What the agent found, spoken between its steps: its own message in the
 * transcript, beside the card rather than inside it, so a finding reads in the
 * flow of the conversation and a run of steps never buries it.
 */
function FindingBubble({ item, anchor, part, onOpen }: {
  item: AgentTraceItem; anchor: TraceAnchor; part: string; onOpen: (item: AgentTraceItem) => void;
}) {
  const html = renderMarkdown(item.text || "", false);
  return <article {...anchorData(anchor, part)} className="agent-finding">
    <button type="button" className="agent-finding-body" onClick={() => onOpen(item)}>
      {/* The existing Markdown parser returns sanitized allowlisted HTML. */}
      <div className="agent-md" dangerouslySetInnerHTML={{ __html: html }} />
    </button>
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
  /** The reader sent this turn's prompt just now, in front of this stream. */
  sent: boolean;
  /** Counts older history put in front of the transcript (see `AgentStream`). */
  historyLoads: number;
};

/**
 * A turn's place for React: its prompt, and which of the turns with that
 * prompt it is. The transcript's own key (`turnKey`) also names the turn's
 * first step, so it changes when that step arrives, and an index changes when
 * older history loads: either would remount a turn that only went on, and a
 * remounted card cannot be seen changing. A prompt keeps this place from the
 * moment it is sent until its turn is over.
 */
function turnSlots(turns: readonly AgentTurn[]): string[] {
  const taken = new Map<string, number>();
  return turns.map((turn) => {
    const prompt = turn.user ? `${turn.user.type === "command" ? "c" : "u"}:${submittedText(turn.user.text || "")}` : "none";
    const nth = taken.get(prompt) ?? 0;
    taken.set(prompt, nth + 1);
    return `${prompt}:${nth}`;
  });
}

/**
 * The prompt the reader sent while this stream was on screen, for as long as
 * it waits to be recorded. A prompt already pending when the stream was first
 * drawn was not seen leaving the field, and once older history has moved the
 * transcript nothing in it is an arrival.
 */
function useSentPrompt(turns: readonly AgentTurn[], historyLoads: number): string | null {
  const pending = turns.find((turn) => turn.user?.pending)?.user?.text ?? null;
  const state = useRef<{ pending: string | null; historyLoads: number; sent: string | null } | null>(null);
  state.current ??= { pending, historyLoads, sent: null };
  const seen = state.current;
  if (seen.pending !== pending) {
    seen.pending = pending;
    seen.sent = pending;
    seen.historyLoads = historyLoads;
  } else if (seen.historyLoads !== historyLoads) {
    seen.historyLoads = historyLoads;
    seen.sent = null;
  }
  return seen.sent;
}

function TraceTurn({ turn, state, anchor, kept, onCopy, onTerminal, onAnswered, onOpenStep }: {
  turn: AgentTurn; state: TurnState; anchor: TraceAnchor; kept?: DetailsState; onCopy?: CopyReply; onTerminal?: () => void;
  onAnswered?: () => void; onOpenStep: OpenStep;
}) {
  const { entries, reply, compacted, interrupted } = splitTurn(turn);
  // Findings are the agent's own words between steps. They leave the card and
  // speak in the transcript, so a run of steps never buries what it concluded.
  // One spoken before any step introduces the work rather than summarising it,
  // so it keeps its place ahead of the card.
  const firstStep = entries.findIndex((item) => item.type !== "assistant");
  const preamble = firstStep < 0 ? entries.filter((item) => item.type === "assistant") : entries.slice(0, firstStep);
  const findings = firstStep < 0 ? [] : entries.slice(firstStep).filter((item) => item.type === "assistant");
  // The card draws `steps`, and the sheet pages through that same list: one
  // source for both, or a press would carry an index into another list.
  const steps = stepRows(entries);
  // A finding between two steps breaks the run there: the rows either side are
  // two deeds with something said between them, not one long stretch.
  const breaks = findingBreaks(entries);
  const { live, waiting } = state;
  const outcome = turnOutcome(turn.items, state);
  const tools = entries.filter((item) => item.type === "tool");
  // A turn that stopped on a failed step already names it.
  if (!live && !reply.length && tools.length && !interrupted && outcome.tone !== "error") {
    // A message sent mid-run starts a new turn; the work goes on there.
    outcome.detail = state.hasNext ? t("work.continued") : t("work.noReply", { step: stepObject(tools[tools.length - 1]) });
  }
  if (state.partial) outcome.detail = [t("work.partial"), outcome.detail].filter(Boolean).join(" · ");
  const models = turnModels(turn.items);
  // A turn that stopped to ask before any step has nothing to show but the needs-you card below it.
  const card = models !== undefined || steps.length > 0 || interrupted || (live && !state.pending && !waiting);
  // The agent stopped to ask while this turn was on screen: its card is raised, not just drawn.
  const asked = useTurned(live && waiting);
  return <>
    {turn.user && <TurnHead item={turn.user} anchorData={anchorData(anchor, "user")} arriving={state.sent} />}
    {state.pending && !turn.items.length && <PendingCard {...state.pending} arriving={state.sent} />}
    {preamble.map((item, index) => <FindingBubble key={`${anchor.key}:pre:${index}`} item={item}
      anchor={anchor} part={`pre-${index}`} onOpen={(step) => onOpenStep(step, steps, { key: anchor.key, ordinal: anchor.ordinal })} />)}
    {card && <WorkCard traceKey={workKey(turn)} entries={steps} breaks={breaks} outcome={outcome} live={live} follow={state.follow} kept={kept}
      verified={state.verified} models={models} span={turnSpan(turn.user, turn.items)} historyLoads={state.historyLoads}
      onOpen={(item, steps) => onOpenStep(item, steps, { key: anchor.key, ordinal: anchor.ordinal })}
      anchor={{ anchor: `${anchor.key}:work`, ordinal: anchor.ordinal, ordinalFromEnd: anchor.ordinalFromEnd }} />}
    {findings.map((item, index) => <FindingBubble key={`${anchor.key}:finding:${index}`} item={item}
      anchor={anchor} part={`finding-${index}`} onOpen={(step) => onOpenStep(step, steps, { key: anchor.key, ordinal: anchor.ordinal })} />)}
    {live && waiting && <NeedsYouCard ask={pendingAsk(turn.items)} raised={asked} onTerminal={onTerminal} onAnswered={onAnswered} />}
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

/**
 * `historyLoads` counts the older pages put in front of the transcript. The
 * stream reads a change in it as history arriving: nothing drawn by that paint
 * is news, whatever its place in a list says.
 */
export function AgentStream({ items, working, waiting = false, stale = false, verified = false, follow = true, hasOlder = false,
  historyLoads = 0, progress, empty, busy, kept,
  onRetry, onTerminal, onAnswered, onNeedOlder, onFollow, onCopyReply, onOpenStep, truncated, older, streamRef, signature }: {
  items: AgentTraceItem[]; working: boolean; waiting?: boolean; stale?: boolean; verified?: boolean; progress?: PromptProgressNote | null;
  follow?: boolean; hasOlder?: boolean; historyLoads?: number;
  empty: AgentEmptySpec; busy?: boolean; kept?: DetailsState;
  onRetry?: () => void; onTerminal?: () => void; onAnswered?: () => void; onNeedOlder?: () => void; onFollow?: (follow: boolean, stream: HTMLElement) => void;
  onCopyReply?: CopyReply; onOpenStep?: OpenStep; truncated?: boolean;
  older?: ReactNode; streamRef?: Ref<HTMLDivElement>; signature?: string;
}) {
  const turns = groupAgentTurns(items);
  const slots = turnSlots(turns);
  const sent = useSentPrompt(turns, historyLoads);
  const openStep = onOpenStep ?? (() => undefined);
  // The transcript read for the first time takes the spinner's place: it fades in, once per read
  // (`has-arrived`). One that was there when the stream was first drawn is not an arrival.
  // Reading is a read in flight with nothing to show yet, whatever the stream says meanwhile
  // ("reading", or that the agent is working).
  const reading = !items.length && busy === true;
  const read = useRef({ reading, arrived: false });
  if (reading) read.current = { reading: true, arrived: false };
  else if (read.current.reading) read.current = { reading: false, arrived: items.length > 0 };
  return <div ref={streamRef} className="agent-stream" role="log" aria-label={t("chat.streamAria")}
    aria-busy={busy === true} tabIndex={0} data-sig={signature} onScroll={event => {
      const stream = event.currentTarget;
      const follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 32;
      onFollow?.(follow, stream);
      if (stream.scrollTop < 32) onNeedOlder?.();
    }}>
    <div className={read.current.arrived ? "agent-stream-inner has-arrived" : "agent-stream-inner"}>
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
        return <TraceTurn key={slots[index]} turn={turn} anchor={turnAnchor(turn, index, turns)}
          state={{ live, waiting: waiting && last, stale, verified, pending, follow,
            hasNext: !last, partial: index === 0 && hasOlder && !turn.user,
            sent: turn.user?.pending === true && sent !== null, historyLoads }}
          kept={kept} onCopy={onCopyReply} onTerminal={onTerminal} onAnswered={onAnswered} onOpenStep={openStep} />;
      })}
    </div>
  </div>;
}
