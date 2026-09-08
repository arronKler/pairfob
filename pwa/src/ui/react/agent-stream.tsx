import { Fragment, type ReactNode, type Ref } from "react";
import { renderMarkdown } from "../../lib/agent-markdown";
import { groupAgentTurns, groupAgentTurnBlocks, processTitle, replyText, turnKey,
  type AgentTurn, type AgentTurnBlock } from "../../lib/agent-trace-view";
import type { AgentTraceItem } from "../../lib/operations";
import { t } from "../../lib/i18n";
import { state } from "../../state";
import type { AgentEmptySpec, DetailsState } from "../agent-chat-stream";
import { AgentDetails } from "./agent-details";
import { AgentStep, type ToolDetailHooks } from "./agent-process";
import { Button, Spinner } from "./chrome";

type CopyReply = (text: string) => void | Promise<void>;

function AssistantReply({ items, final, live, onCopy }: {
  items: AgentTraceItem[]; final: boolean; live: boolean; onCopy?: CopyReply;
}) {
  const text = replyText(items);
  return <article className={`agent-assistant${final ? " agent-assistant-final" : " agent-assistant-intermediate"}`}>
    {/* The existing Markdown parser returns sanitized allowlisted HTML. */}
    <div className="agent-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    {final && !live && onCopy && text && <div className="agent-reply-actions">
      <Button className="agent-reply-copy" aria-label={t("chat.copyReplyAria")} onClick={() => void onCopy(text)}>{t("chat.copyReply")}</Button>
    </div>}
  </article>;
}

function ProcessCard({ turn, items, blockIndex, live, kept, hooks }: {
  turn: AgentTurn; items: AgentTraceItem[]; blockIndex: number; live: boolean; kept?: DetailsState; hooks: ToolDetailHooks;
}) {
  const scope = `${turnKey(turn)}:${blockIndex}`;
  return <AgentDetails traceKey={`p:${scope}`} className="agent-process" auto={live} kept={kept}>
    <summary className="agent-process-summary">{processTitle(items, live)}</summary>
    <div className="agent-process-body">
      {items.map((item, index) => <AgentStep key={index} item={item} index={index} scope={scope} kept={kept} hooks={hooks} />)}
    </div>
  </AgentDetails>;
}

function ProcessFold({ turn, blocks, kept, hooks, onCopy }: {
  turn: AgentTurn; blocks: AgentTurnBlock[]; kept?: DetailsState; hooks: ToolDetailHooks; onCopy?: CopyReply;
}) {
  const count = blocks.reduce((total, block) => total + block.items.length, 0);
  let offset = 0;
  return <AgentDetails traceKey={`f:${turnKey(turn)}`} className="agent-process agent-reply-fold" kept={kept}>
    <summary className="agent-process-summary agent-reply-fold-summary">
      <span className="agent-reply-fold-title">{t("trace.nSteps", { n: count })}</span>
    </summary>
    <div className="agent-process-body agent-reply-fold-body">
      {blocks.map((block, blockIndex) => {
        const start = offset;
        offset += block.items.length;
        return block.type === "reply" ? <AssistantReply key={`reply:${blockIndex}`} items={block.items} final={false} live={false} onCopy={onCopy} />
          : <Fragment key={`process:${blockIndex}`}>
            {block.items.map((item, index) => <AgentStep key={start + index} item={item} index={start + index}
              scope={turnKey(turn)} kept={kept} hooks={hooks} />)}
          </Fragment>;
      })}
    </div>
  </AgentDetails>;
}

function TraceTurn({ turn, live, kept, hooks, onCopy }: {
  turn: AgentTurn; live: boolean; kept?: DetailsState; hooks: ToolDetailHooks; onCopy?: CopyReply;
}) {
  const blocks = groupAgentTurnBlocks(turn.items);
  const finalReply = !live && blocks.at(-1)?.type === "reply" ? blocks.length - 1 : -1;
  let lastProcess = -1;
  for (const [index, block] of blocks.entries()) if (block.type === "process") lastProcess = index;
  return <>
    {turn.user && <article className="agent-user"><div className="agent-user-text">{turn.user.text || ""}</div></article>}
    {finalReply > 0 && <ProcessFold turn={turn} blocks={blocks.slice(0, finalReply)} kept={kept} hooks={hooks} onCopy={onCopy} />}
    {finalReply >= 0 ? <AssistantReply items={blocks[finalReply].items} final live={live} onCopy={onCopy} />
      : blocks.map((block, index) => block.type === "process"
        ? <ProcessCard key={`process:${index}`} turn={turn} items={block.items} blockIndex={index}
          live={live && index === lastProcess} kept={kept} hooks={hooks} />
        : <AssistantReply key={`reply:${index}`} items={block.items} final={false} live={live} onCopy={onCopy} />)}
    {live && <div className="agent-run-status" role="status" aria-live="polite">
      <Spinner /><span>{turn.items.length ? t("trace.runningSteps", { n: turn.items.length }) : t("chat.runningEllipsis")}</span>
    </div>}
  </>;
}

function EmptyPanel({ spec, onRetry }: { spec: AgentEmptySpec; onRetry?: () => void }) {
  return <div className={`agent-empty agent-empty-${spec.kind}`} role={spec.kind === "error" ? "alert" : "status"}>
    {(spec.kind === "loading" || spec.kind === "working") && <Spinner />}
    <p className="agent-empty-title">{spec.title}</p>
    {spec.sub && <p className="agent-empty-sub">{spec.sub}</p>}
    {spec.kind === "error" && onRetry && <Button className="btn btn-small" onClick={onRetry}>{t("retry")}</Button>}
  </div>;
}

export function AgentStream({ items, working, empty, busy, kept, onRetry, onNeedOlder, onFollow, onCopyReply,
  toolDetail, onNeedToolDetail, truncated, older, streamRef, signature }: {
  items: AgentTraceItem[]; working: boolean; empty: AgentEmptySpec; busy?: boolean; kept?: DetailsState;
  onRetry?: () => void; onNeedOlder?: () => void; onFollow?: (follow: boolean) => void; onCopyReply?: CopyReply;
  toolDetail?: ToolDetailHooks["view"]; onNeedToolDetail?: ToolDetailHooks["need"]; truncated?: boolean;
  older?: ReactNode; streamRef?: Ref<HTMLDivElement>; signature?: string;
}) {
  const turns = groupAgentTurns(items);
  const hooks = { view: toolDetail, need: onNeedToolDetail };
  return <div ref={streamRef} className="agent-stream" role="log" aria-label={t("chat.streamAria")}
    aria-busy={busy === true} tabIndex={0} data-sig={signature} onScroll={event => {
      const stream = event.currentTarget;
      const follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 32;
      state.agentTraceFollow = follow;
      onFollow?.(follow);
      if (stream.scrollTop < 32) onNeedOlder?.();
    }}>
    <div className="agent-stream-inner">
      {older}
      {!items.length && <EmptyPanel spec={empty} onRetry={onRetry} />}
      {truncated && items.length > 0 && <p className="agent-trace-limit">{t("chat.truncated")}</p>}
      {turns.map((turn, index) => <TraceTurn key={`${turnKey(turn)}:${index}`} turn={turn} live={working && index === turns.length - 1}
        kept={kept} hooks={hooks} onCopy={onCopyReply} />)}
    </div>
  </div>;
}
