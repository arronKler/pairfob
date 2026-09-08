import { useCallback } from "react";
import { t } from "../../lib/i18n";
import { stepKey, stepSummary, toolState } from "../../lib/agent-trace-view";
import type { AgentTraceItem } from "../../lib/operations";
import type { AgentTraceDetailState } from "../../lib/agent-trace-cache";
import type { DetailsState } from "../agent-chat-stream";
import { AgentDetails } from "./agent-details";
import { Button, Spinner } from "./chrome";

export type ToolDetailHooks = {
  view?: (item: AgentTraceItem) => AgentTraceDetailState;
  need?: (detailRef: string) => void;
};

function ToolStateMark({ item }: { item: AgentTraceItem }) {
  const status = toolState(item);
  const label = t(status === "running" ? "trace.runningTool" : status === "error" ? "trace.failedTool" : "trace.doneTool");
  return <span className={`agent-tool-state agent-tool-state-${status}`} aria-label={label} title={label}>
    {status === "running" ? <Spinner /> : status === "error" ? "!" : "✓"}
  </span>;
}

function ToolFields({ item, detail }: { item: AgentTraceItem; detail: AgentTraceDetailState }) {
  const body = detail.detail;
  const text = body?.text ?? item.text;
  const input = body?.input ?? item.input;
  const output = body?.output ?? item.output;
  return <>
    {input && <><p className="agent-step-label">{t("chat.params")}</p><pre className="agent-step-body">{input}</pre></>}
    {output && <><p className="agent-step-label">{t("chat.result")}</p><pre className="agent-step-body">{output}</pre></>}
    {!input && !output && text && <pre className="agent-step-body">{text}</pre>}
    {body?.truncated && <p className="agent-detail-limit">{t("chat.truncated")}</p>}
  </>;
}

function ToolDetail({ item, detail, hooks }: { item: AgentTraceItem; detail: AgentTraceDetailState; hooks: ToolDetailHooks }) {
  if (!item.detailRef || detail.status === "ready") return <ToolFields item={item} detail={detail} />;
  if (detail.status === "loading") return <div className="agent-detail-state" role="status">
    <Spinner /><span>{t("chat.detailLoading")}</span>
  </div>;
  if (detail.status === "error") return <div className="agent-detail-state agent-detail-error" role="alert">
    <span>{detail.message || t("chat.detailFailed")}</span>
    <Button className="btn btn-small agent-detail-retry" onClick={() => hooks.need?.(item.detailRef!)}>{t("retry")}</Button>
  </div>;
  return null;
}

export function AgentStep({ item, index, scope, kept, hooks }: {
  item: AgentTraceItem; index: number; scope: string; kept?: DetailsState; hooks: ToolDetailHooks;
}) {
  const detail: AgentTraceDetailState = hooks.view?.(item) ?? { status: item.detailRef ? "idle" : "ready" };
  const need = hooks.need;
  const onOpen = useCallback((source: "automatic" | "toggle") => {
    if (item.detailRef && (detail.status === "idle" || (source === "toggle" && detail.status === "error"))) need?.(item.detailRef);
  }, [item.detailRef, detail.status, need]);
  const preview = item.type === "thinking" && item.text ? item.text.replace(/\s+/g, " ").trim() : "";
  const status = item.type === "tool" ? ` is-${toolState(item)}` : "";
  return <AgentDetails traceKey={stepKey(item, index, scope)} className={`agent-step agent-${item.type}${status}`}
    kept={kept} onOpen={item.type === "tool" && item.detailRef ? onOpen : undefined}>
    <summary className="agent-step-summary">
      {item.type === "tool" && <ToolStateMark item={item} />}
      <span className="agent-step-title">{stepSummary(item)}</span>
      {preview && <span className="agent-thinking-preview" title={preview}>{preview}</span>}
    </summary>
    {item.type === "thinking" && item.text && <pre className="agent-step-body">{item.text}</pre>}
    {item.type === "tool" && <ToolDetail item={item} detail={detail} hooks={hooks} />}
  </AgentDetails>;
}
