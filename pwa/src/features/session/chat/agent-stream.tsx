import { ChevronRight, ChevronsDownUp, CircleSlash, SquareTerminal } from "lucide-react";
import { Fragment, type ReactNode, type Ref } from "react";
import { renderMarkdown } from "../../../lib/agent-markdown";
import { groupAgentTurns, groupAgentTurnBlocks, processTitle, replyText, turnKey,
  type AgentTurn, type AgentTurnBlock } from "../../../lib/agent-trace-view";
import { isTraceMarker, type AgentTraceItem } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import type { AgentEmptySpec, DetailsState } from "./agent-chat-stream";
import { AgentDetails } from "./agent-details";
import { AgentStep, type ToolDetailHooks } from "./agent-process";
import { Button, Spinner } from "../../../shared/ui/primitives";

type CopyReply = (text: string) => void | Promise<void>;
type TraceAnchor = { key: string; ordinal: number; ordinalFromEnd: number };

function anchorData(anchor: TraceAnchor, part: string) {
  return {
    "data-trace-anchor": `${anchor.key}:${part}`,
    "data-trace-ordinal": anchor.ordinal,
    "data-trace-ordinal-end": anchor.ordinalFromEnd,
  };
}

function AssistantReply({ items, final, live, anchor, part, onCopy }: {
  items: AgentTraceItem[]; final: boolean; live: boolean; anchor: TraceAnchor; part: string; onCopy?: CopyReply;
}) {
  const text = replyText(items);
  return <article {...anchorData(anchor, part)} className={`agent-assistant${final ? " agent-assistant-final" : " agent-assistant-intermediate"}`}>
    {/* The existing Markdown parser returns sanitized allowlisted HTML. */}
    <div className="agent-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    {final && !live && onCopy && text && <div className="agent-reply-actions">
      <Button className="agent-reply-copy" aria-label={t("chat.copyReplyAria")} onClick={() => void onCopy(text)}>{t("chat.copyReply")}</Button>
    </div>}
  </article>;
}

function TurnHead({ item, anchor }: { item: AgentTraceItem; anchor: TraceAnchor }) {
  const text = item.text || "";
  if (item.type === "command") {
    return <article className="agent-command" {...anchorData(anchor, "user")} aria-label={t("trace.commandAria", { cmd: text })}>
      <SquareTerminal className="agent-command-icon" size={14} aria-hidden="true" />
      <code className="agent-command-text">{text}</code>
    </article>;
  }
  return <article className="agent-user" {...anchorData(anchor, "user")}><div className="agent-user-text">{text}</div></article>;
}

/** Compaction and interrupt are timeline facts, not steps: they never fold. */
function TraceMarkers({ items }: { items: AgentTraceItem[] }) {
  return <>{items.map((item, index) => item.type === "compaction"
    ? <div key={index} className="agent-marker agent-marker-compaction" role="note">
      <ChevronsDownUp size={14} aria-hidden="true" /><span>{t("trace.compacted")}</span>
    </div>
    : <div key={index} className="agent-marker agent-marker-interrupt" role="note">
      <CircleSlash size={14} aria-hidden="true" /><span>{t("trace.interrupted")}</span>
    </div>)}</>;
}

function ProcessCard({ turn, items, blockIndex, live, anchor, kept, hooks }: {
  turn: AgentTurn; items: AgentTraceItem[]; blockIndex: number; live: boolean; anchor: TraceAnchor; kept?: DetailsState; hooks: ToolDetailHooks;
}) {
  const scope = `${turnKey(turn)}:${blockIndex}`;
  return <AgentDetails traceKey={`p:${scope}`} className="agent-process" auto={live} kept={kept}
    dataTraceAnchor={`${anchor.key}:process:${blockIndex}`} dataTraceOrdinal={anchor.ordinal} dataTraceOrdinalEnd={anchor.ordinalFromEnd}>
    <summary className="agent-process-summary">{processTitle(items, live)}</summary>
    <div className="agent-process-body">
      {items.map((item, index) => <AgentStep key={index} item={item} index={index} scope={scope} kept={kept} hooks={hooks} />)}
    </div>
  </AgentDetails>;
}

function ProcessFold({ turn, blocks, anchor, kept, hooks, onCopy }: {
  turn: AgentTurn; blocks: AgentTurnBlock[]; anchor: TraceAnchor; kept?: DetailsState; hooks: ToolDetailHooks; onCopy?: CopyReply;
}) {
  const count = blocks.reduce((total, block) => total + block.items.length, 0);
  let offset = 0;
  return <AgentDetails traceKey={`f:${turnKey(turn)}`} className="agent-process agent-reply-fold" kept={kept}
    dataTraceAnchor={`${anchor.key}:fold`} dataTraceOrdinal={anchor.ordinal} dataTraceOrdinalEnd={anchor.ordinalFromEnd}>
    <summary className="agent-process-summary agent-reply-fold-summary">
      <ChevronRight className="agent-reply-fold-chevron" size={16} aria-hidden="true" />
      <span className="agent-reply-fold-title">{t("trace.nSteps", { n: count })}</span>
    </summary>
    <div className="agent-process-body agent-reply-fold-body">
      {blocks.map((block, blockIndex) => {
        const start = offset;
        offset += block.items.length;
        return block.type === "reply" ? <AssistantReply key={`reply:${blockIndex}`} items={block.items} final={false} live={false}
          anchor={anchor} part={`fold-reply:${blockIndex}`} onCopy={onCopy} />
          : <Fragment key={`process:${blockIndex}`}>
            {block.items.map((item, index) => <AgentStep key={start + index} item={item} index={start + index}
              scope={turnKey(turn)} kept={kept} hooks={hooks} />)}
          </Fragment>;
      })}
    </div>
  </AgentDetails>;
}

function TraceTurn({ turn, live, anchor, kept, hooks, onCopy }: {
  turn: AgentTurn; live: boolean; anchor: TraceAnchor; kept?: DetailsState; hooks: ToolDetailHooks; onCopy?: CopyReply;
}) {
  const all = groupAgentTurnBlocks(turn.items);
  // A trailing interrupt or compaction follows the reply instead of hiding it.
  let end = all.length;
  while (end > 0 && all[end - 1].type === "marker") end -= 1;
  const blocks = all.slice(0, end);
  const steps = turn.items.filter((item) => !isTraceMarker(item.type)).length;
  const trailing = all.slice(end).flatMap((block) => block.items);
  const finalReply = !live && blocks.at(-1)?.type === "reply" ? blocks.length - 1 : -1;
  // Markers before a final reply stay outside the collapsed fold.
  const folded = finalReply > 0 ? blocks.slice(0, finalReply) : [];
  const foldSteps = folded.filter((block) => block.type !== "marker");
  const foldMarkers = folded.filter((block) => block.type === "marker").flatMap((block) => block.items);
  let lastProcess = -1;
  for (const [index, block] of blocks.entries()) if (block.type === "process") lastProcess = index;
  return <>
    {turn.user && <TurnHead item={turn.user} anchor={anchor} />}
    {foldSteps.length > 0 && <ProcessFold turn={turn} blocks={foldSteps} anchor={anchor}
      kept={kept} hooks={hooks} onCopy={onCopy} />}
    {foldMarkers.length > 0 && <TraceMarkers items={foldMarkers} />}
    {finalReply >= 0 ? <AssistantReply items={blocks[finalReply].items} final live={live}
      anchor={anchor} part={`reply:${finalReply}`} onCopy={onCopy} />
      : blocks.map((block, index) => block.type === "marker"
        ? <TraceMarkers key={`marker:${index}`} items={block.items} />
        : block.type === "process"
        ? <ProcessCard key={`process:${index}`} turn={turn} items={block.items} blockIndex={index}
          live={live && index === lastProcess} anchor={anchor} kept={kept} hooks={hooks} />
        : <AssistantReply key={`reply:${index}`} items={block.items} final={false} live={live}
          anchor={anchor} part={`reply:${index}`} onCopy={onCopy} />)}
    {trailing.length > 0 && <TraceMarkers items={trailing} />}
    {live && <div className="agent-run-status" role="status" aria-live="polite">
      <Spinner /><span>{steps ? t("trace.runningSteps", { n: steps }) : t("chat.runningEllipsis")}</span>
    </div>}
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

export function AgentStream({ items, working, empty, busy, kept, onRetry, onTerminal, onNeedOlder, onFollow, onCopyReply,
  toolDetail, onNeedToolDetail, truncated, older, streamRef, signature }: {
  items: AgentTraceItem[]; working: boolean; empty: AgentEmptySpec; busy?: boolean; kept?: DetailsState;
  onRetry?: () => void; onTerminal?: () => void; onNeedOlder?: () => void; onFollow?: (follow: boolean, stream: HTMLElement) => void; onCopyReply?: CopyReply;
  toolDetail?: ToolDetailHooks["view"]; onNeedToolDetail?: ToolDetailHooks["need"]; truncated?: boolean;
  older?: ReactNode; streamRef?: Ref<HTMLDivElement>; signature?: string;
}) {
  const turns = groupAgentTurns(items);
  const hooks = { view: toolDetail, need: onNeedToolDetail };
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
      {turns.map((turn, index) => {
        const anchor = turnAnchor(turn, index, turns);
        return <TraceTurn key={`${turnKey(turn)}:${index}`} turn={turn} anchor={anchor}
          live={working && empty.kind !== "unavailable" && index === turns.length - 1 && turn.items.at(-1)?.type !== "interrupt"}
          kept={kept} hooks={hooks} onCopy={onCopyReply} />;
      })}
    </div>
  </div>;
}
