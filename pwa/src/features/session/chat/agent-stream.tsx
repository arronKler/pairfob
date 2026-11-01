import { memo, type ReactNode, type Ref } from "react";
import { renderMarkdown } from "../../../lib/agent-markdown";
import { groupAgentTurns, groupAgentTurnBlocks, processTitle, replyText, turnKey,
  type AgentTurn } from "../../../lib/agent-trace-view";
import type { AgentTraceItem } from "../../../lib/operations";
import { langRevision, t } from "../../../lib/i18n";
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

type TraceTurnProps = {
  turn: AgentTurn; live: boolean; anchor: TraceAnchor; kept?: DetailsState; hooks: ToolDetailHooks; onCopy?: CopyReply;
  /** Language revision: a finished turn shows t() copy, so it must re-render when the language changes. */
  lang: number;
};

// Keep in step with the fields of AgentTraceItem (lib/operations.ts).
function sameItem(a: AgentTraceItem, b: AgentTraceItem): boolean {
  return a === b || (a.type === b.type && a.text === b.text && a.name === b.name && a.input === b.input
    && a.output === b.output && a.toolState === b.toolState && a.detailRef === b.detailRef);
}

function sameItems(a: readonly AgentTraceItem[], b: readonly AgentTraceItem[]): boolean {
  return a.length === b.length && a.every((item, index) => sameItem(item, b[index]));
}

/** A turn re-renders only when what it shows changed; tool detail hooks matter only to turns with detail refs. */
function sameTurn(prev: TraceTurnProps, next: TraceTurnProps): boolean {
  if (next.live || prev.lang !== next.lang || prev.live !== next.live || prev.kept !== next.kept || prev.onCopy !== next.onCopy) return false;
  if (prev.anchor.key !== next.anchor.key || prev.anchor.ordinal !== next.anchor.ordinal
    || prev.anchor.ordinalFromEnd !== next.anchor.ordinalFromEnd) return false;
  if (prev.turn.user?.text !== next.turn.user?.text || !sameItems(prev.turn.items, next.turn.items)) return false;
  if (prev.hooks.view === next.hooks.view && prev.hooks.need === next.hooks.need) return true;
  return !next.turn.items.some(item => item.detailRef);
}

const TraceTurn = memo(function TraceTurn({ turn, live, anchor, kept, hooks, onCopy }: TraceTurnProps) {
  const blocks = groupAgentTurnBlocks(turn.items);
  const finalReply = !live && blocks.at(-1)?.type === "reply" ? blocks.length - 1 : -1;
  let lastProcess = -1;
  for (const [index, block] of blocks.entries()) if (block.type === "process") lastProcess = index;
  return <>
    {turn.user && <article className="agent-user" {...anchorData(anchor, "user")}><div className="agent-user-text">{turn.user.text || ""}</div></article>}
    {blocks.map((block, index) => block.type === "process"
      ? <ProcessCard key={`process:${index}`} turn={turn} items={block.items} blockIndex={index}
        live={live && index === lastProcess} anchor={anchor} kept={kept} hooks={hooks} />
      : <AssistantReply key={`reply:${index}`} items={block.items} final={index === finalReply} live={live}
        anchor={anchor} part={`reply:${index}`} onCopy={onCopy} />)}
    {live && <div className="agent-run-status" role="status" aria-live="polite">
      <Spinner /><span>{turn.items.length ? t("trace.runningSteps", { n: turn.items.length }) : t("chat.runningEllipsis")}</span>
    </div>}
  </>;
}, sameTurn);

function EmptyPanel({ spec, onRetry, onTerminal }: { spec: AgentEmptySpec; onRetry?: () => void; onTerminal?: () => void }) {
  return <div className={`agent-empty agent-empty-${spec.kind}`} role={spec.kind === "error" ? "alert" : "status"}>
    {(spec.kind === "loading" || spec.kind === "working") && <Spinner />}
    <p className="agent-empty-title">{spec.title}</p>
    {spec.sub && <p className="agent-empty-sub">{spec.sub}</p>}
    {spec.kind === "unavailable" && onTerminal && <Button className="btn btn-small agent-open-terminal" onClick={onTerminal}>{t("chat.openTerminal")}</Button>}
    {spec.kind === "error" && onRetry && <Button className="btn btn-small" onClick={onRetry}>{t("retry")}</Button>}
  </div>;
}

function turnAnchors(turns: readonly AgentTurn[]): TraceAnchor[] {
  const keys = turns.map(turnKey);
  const total = new Map<string, number>();
  for (const key of keys) total.set(key, (total.get(key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return keys.map(key => {
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { key, ordinal, ordinalFromEnd: (total.get(key) ?? 1) - ordinal - 1 };
  });
}

export function AgentStream({ items, working, empty, busy, kept, onRetry, onTerminal, onNeedOlder, onFollow, onCopyReply,
  toolDetail, onNeedToolDetail, truncated, older, streamRef, signature }: {
  items: AgentTraceItem[]; working: boolean; empty: AgentEmptySpec; busy?: boolean; kept?: DetailsState;
  onRetry?: () => void; onTerminal?: () => void; onNeedOlder?: () => void; onFollow?: (follow: boolean, stream: HTMLElement) => void; onCopyReply?: CopyReply;
  toolDetail?: ToolDetailHooks["view"]; onNeedToolDetail?: ToolDetailHooks["need"]; truncated?: boolean;
  older?: ReactNode; streamRef?: Ref<HTMLDivElement>; signature?: string;
}) {
  const turns = groupAgentTurns(items);
  const anchors = turnAnchors(turns);
  const lang = langRevision();
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
        return <TraceTurn key={`${anchors[index].key}:${index}`} turn={turn} anchor={anchors[index]}
          live={working && empty.kind !== "unavailable" && index === turns.length - 1}
          kept={kept} hooks={hooks} onCopy={onCopyReply} lang={lang} />;
      })}
    </div>
  </div>;
}
