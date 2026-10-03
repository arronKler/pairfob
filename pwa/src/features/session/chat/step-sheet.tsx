import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy } from "lucide-react";
import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { t } from "../../../lib/i18n";
import { renderMarkdown } from "../../../lib/agent-markdown";
import type { AgentTraceItem } from "../../../lib/operations";
import type { AgentTraceDetailState } from "../../../lib/agent-trace-cache";
import { categoryLabel, stepCategory, stepObject, stepState, type StepState } from "../../../lib/agent-trace-steps";
import { showActionSheet } from "../../../shared/ui/overlay/action-sheet";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { loadToolDetail, toolDetailView } from "./agent-chat-detail";
import { useChat } from "../hooks";

/**
 * One step's arguments and output, in the same bottom sheet the session menu
 * uses. Bodies load on open; the chat stream itself never grows with them.
 */
export function openStepSheet(paneId: string, item: AgentTraceItem, verified: boolean, steps: AgentTraceItem[] = [item],
  locate?: () => AgentTraceItem[] | null): void {
  const list = steps.includes(item) ? steps : [item];
  showActionSheet(t("sheet.title"), () => <StepPager paneId={paneId} steps={list} start={list.indexOf(item)} verified={verified} locate={locate} />,
    { className: "step-sheet", expandable: true });
}

/** The same step in the turn's latest steps: same position, same kind and tool. */
function latestStep(snapshot: AgentTraceItem, current: AgentTraceItem[] | null, index: number): AgentTraceItem {
  const next = current?.[index];
  return next && next.type === snapshot.type && next.name === snapshot.name ? next : snapshot;
}

/**
 * The card's steps in order: previous / next move through them without closing
 * the sheet. While open it follows trace updates, so a running step's state and
 * output arrive in place and new steps extend the count.
 */
function StepPager({ paneId, steps, start, verified, locate }: {
  paneId: string; steps: AgentTraceItem[]; start: number; verified: boolean; locate?: () => AgentTraceItem[] | null;
}) {
  useChat();
  const [index, setIndex] = useState(start);
  const current = locate?.() ?? null;
  const count = Math.max(steps.length, current?.length ?? 0);
  const item = index < steps.length ? latestStep(steps[index], current, index) : current?.[index] ?? steps[steps.length - 1];
  const category = stepCategory(item);
  return <div className="step-pager">
    <div className="step-head">
      <span className="step-head-copy"><b>{categoryLabel(category)}</b>
        {item.type === "tool" ? <code>{stepObject(item)}</code> : null}</span>
      {count > 1 && <span className="step-nav">
        <Button className="step-nav-btn" aria-label={t("sheet.prev")} disabled={index === 0} onClick={() => setIndex(index - 1)}>
          <ChevronLeft size={18} aria-hidden="true" /></Button>
        <span className="step-nav-pos">{t("sheet.position", { i: index + 1, n: count })}</span>
        <Button className="step-nav-btn" aria-label={t("sheet.next")} disabled={index >= count - 1} onClick={() => setIndex(index + 1)}>
          <ChevronRight size={18} aria-hidden="true" /></Button>
      </span>}
    </div>
    <StepSheetBody key={index} paneId={paneId} item={item} verified={verified} />
  </div>;
}

function StatePill({ state }: { state: StepState }) {
  const label = t(`work.state.${state}`);
  return <span className={`step-pill is-${state}`}>
    {state === "running" ? <Spinner /> : state === "error" ? <CircleAlert size={13} aria-hidden="true" />
      : state === "done" ? <Check size={13} aria-hidden="true" /> : null}
    {label}
  </span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <Button className="step-copy" onClick={() => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
  }}><Copy size={13} aria-hidden="true" />{copied ? t("sheet.copied") : t("sheet.copy")}</Button>;
}

function Section({ title, copy, children }: { title: string; copy?: string; children: ReactNode }) {
  return <section className="step-section">
    <header className="step-section-head"><h4>{title}</h4>{copy ? <CopyButton text={copy} /> : null}</header>
    {children}
  </section>;
}

/** A flat JSON object reads best as a key/value table; anything nested stays formatted JSON. */
function flatArguments(input: string): Array<[string, string]> | null {
  try {
    const value = JSON.parse(input) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const rows: Array<[string, string]> = [];
    for (const [key, field] of Object.entries(value)) {
      if (field !== null && typeof field === "object") return null;
      rows.push([key, String(field)]);
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function prettyJSON(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function commandText(input: string): string {
  const rows = flatArguments(input);
  const command = rows?.find(([key]) => key === "command" || key === "cmd" || key === "script")?.[1];
  return command ?? "";
}

function Arguments({ item, input }: { item: AgentTraceItem; input: string }) {
  if (stepCategory(item) === "command") {
    const command = commandText(input);
    if (command) return <Section title={t("sheet.command")} copy={command}><pre className="step-code">{command}</pre></Section>;
  }
  const rows = flatArguments(input);
  return <Section title={t("sheet.params")} copy={input}>
    {rows ? <dl className="step-args">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      : <pre className="step-code">{prettyJSON(input)}</pre>}
  </Section>;
}

function ToolBody({ item, detail }: { item: AgentTraceItem; detail: AgentTraceDetailState }) {
  const body = detail.detail;
  const input = body?.input ?? item.input ?? "";
  const output = body?.output ?? item.output ?? "";
  return <>
    {input && <Arguments item={item} input={input} />}
    <Section title={t("sheet.output")} copy={output || undefined}>
      {output ? <pre className="step-code">{output}</pre> : <p className="step-empty">{t("sheet.empty")}</p>}
    </Section>
    {body?.truncated && <p className="step-note">{t("sheet.truncated")}</p>}
    {stepCategory(item) === "subtask" && <p className="step-note">{t("work.subtaskHidden")}</p>}
  </>;
}

function StepSheetBody({ paneId, item, verified }: { paneId: string; item: AgentTraceItem; verified: boolean }) {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  // The sheet is its own modal root: repaint it as soon as the body arrives.
  const changed = useCallback(() => flushSync(refresh), []);
  const ref = item.detailRef;
  const detail: AgentTraceDetailState = ref ? toolDetailView(paneId, ref) : { status: "ready" };
  useEffect(() => {
    if (!ref || detail.status !== "idle") return;
    let open = true;
    // Start after the commit, so the synchronous "loading" repaint is not a nested render.
    queueMicrotask(() => { if (open) loadToolDetail(paneId, ref, changed); });
    return () => { open = false; };
  }, [paneId, ref, detail.status, changed]);
  if (item.type === "thinking") {
    return <div className="step-sheet-body"><Section title={t("sheet.thinking")} copy={item.text}><pre className="step-prose">{item.text}</pre></Section></div>;
  }
  if (item.type === "assistant") {
    // The Markdown renderer returns sanitized allowlisted HTML.
    return <div className="step-sheet-body"><div className="agent-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text || "") }} /></div>;
  }
  return <div className="step-sheet-body">
    <div className="step-sheet-state"><StatePill state={stepState(item, verified)} /></div>
    {detail.status === "loading" && <div className="agent-detail-state" role="status"><Spinner /><span>{t("chat.detailLoading")}</span></div>}
    {detail.status === "error" && <div className="agent-detail-state agent-detail-error" role="alert">
      <span>{detail.message || t("chat.detailFailed")}</span>
      <Button className="btn btn-small" onClick={() => { if (ref) loadToolDetail(paneId, ref, changed); }}>{t("retry")}</Button>
    </div>}
    {(detail.status === "ready" || !ref) && <ToolBody item={item} detail={detail} />}
  </div>;
}
