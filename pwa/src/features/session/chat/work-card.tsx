import {
  Check, ChevronRight, CircleSlash, FileText, GitBranch, Globe, ListChecks, MessageCircleQuestionMark, Pencil, Plug, Search,
  Sparkles, Terminal, TriangleAlert, WifiOff, Wrench, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import {
  categoryLabel, formatElapsed, stepCategory, stepObject, stepState, type StepCategory, type TurnOutcome, type TurnTone,
} from "../../../lib/agent-trace-steps";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { daemonNow } from "../../../lib/agent-trace-clock";
import type { DetailsState } from "./agent-chat-stream";
import { AgentDetails } from "./agent-details";

const CATEGORY_ICON: Record<StepCategory, LucideIcon> = {
  read: FileText, search: Search, edit: Pencil, command: Terminal, web: Globe, subtask: GitBranch,
  plan: ListChecks, question: MessageCircleQuestionMark, mcp: Plug, think: Sparkles, other: Wrench,
};

/** Live cards show the latest steps; earlier ones stay one tap away. */
const LIVE_STEPS = 4;
/** Long cards offer failed/edited filters. */
const FILTER_FROM = 9;
type Filter = "all" | "failed" | "edits";

function ToneMark({ tone }: { tone: TurnTone }) {
  if (tone === "running") return <Spinner className="work-tone" />;
  const Icon = tone === "done" ? Check : tone === "error" ? X : tone === "waiting" ? TriangleAlert
    : tone === "interrupted" ? CircleSlash : tone === "stale" ? WifiOff : null;
  return Icon ? <Icon className="work-tone" size={16} aria-hidden="true" /> : <span className="work-tone work-dot" aria-hidden="true" />;
}

/** "2m 14s so far" while running (ticking), "Took 3m 5s" once done; "" under a second or without times. */
function useElapsed(start: number | undefined, end: number | undefined, live: boolean): string {
  // Record times come from the computer's clock; measure against the same clock.
  const [now, setNow] = useState(() => daemonNow());
  useEffect(() => {
    if (!live || start === undefined) return;
    setNow(daemonNow());
    const timer = setInterval(() => setNow(daemonNow()), 1000);
    return () => clearInterval(timer);
  }, [live, start]);
  const until = live ? now : end;
  if (start === undefined || until === undefined || until - start < 1000) return "";
  return t(live ? "work.elapsedLive" : "work.elapsed", { time: formatElapsed(until - start) });
}

type OpenStep = (item: AgentTraceItem, steps: AgentTraceItem[]) => void;

function StepRow({ item, verified, onOpen }: { item: AgentTraceItem; verified: boolean; onOpen: (item: AgentTraceItem) => void }) {
  const category = stepCategory(item);
  const Icon = CATEGORY_ICON[category];
  const object = stepObject(item);
  if (item.type === "assistant") {
    return <li><Button className="work-step work-note" onClick={() => onOpen(item)}>
      <span className="work-note-text">{item.text}</span>
    </Button></li>;
  }
  const state = item.type === "tool" ? stepState(item, verified) : null;
  const stateLabel = state ? t(`work.state.${state}`) : "";
  const aria = state ? t("work.stepAria", { category: categoryLabel(category), object, state: stateLabel }) : `${categoryLabel(category)} ${object}`;
  return <li><Button className={`work-step is-${category}${state ? ` is-${state}` : ""}`} aria-label={aria}
    title={category === "subtask" ? t("work.subtaskHidden") : undefined} onClick={() => onOpen(item)}>
    <Icon className="work-step-icon" size={15} aria-hidden="true" />
    <span className={`work-step-text${item.type === "thinking" ? " is-prose" : ""}`}>{object || categoryLabel(category)}</span>
    {state === "running" ? <Spinner className="work-step-state" />
      : state === "error" ? <X className="work-step-state" size={15} aria-hidden="true" />
      : state === "done" ? <Check className="work-step-state" size={15} aria-hidden="true" />
      : state === "ended" ? <span className="work-step-state work-dot" aria-hidden="true" /> : null}
  </Button></li>;
}

/**
 * Open while the turn runs. When it ends while the reader is scrolled up, it
 * stays open until they return to the latest message, so what they are reading
 * does not jump.
 */
function useHeldOpen(live: boolean, follow: boolean): boolean {
  const [held, setHeld] = useState(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && !follow) setHeld(true);
    wasLive.current = live;
  }, [live, follow]);
  useEffect(() => { if (follow) setHeld(false); }, [follow]);
  return live || held;
}

/**
 * One card per turn between the prompt and the reply: a result-first header
 * and the ordered steps, each opening its own sheet. Running cards start open,
 * finished ones closed; a reader's own toggle is kept like any other details.
 */
export function WorkCard({ traceKey, entries, outcome, live, follow = true, kept, verified, span, anchor, onOpen }: {
  traceKey: string; entries: AgentTraceItem[]; outcome: TurnOutcome; live: boolean; follow?: boolean; kept?: DetailsState;
  verified: boolean; span?: { start?: number; end?: number };
  anchor: { anchor: string; ordinal: number; ordinalFromEnd: number }; onOpen: OpenStep;
}) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const open = useHeldOpen(live, follow);
  const elapsed = useElapsed(span?.start, span?.end, live && outcome.tone === "running");
  const detail = [elapsed, outcome.detail].filter(Boolean).join(" · ");
  const failed = entries.filter((item) => item.type === "tool" && stepState(item, verified) === "error");
  const edits = entries.filter((item) => item.type === "tool" && stepCategory(item) === "edit");
  const filters = entries.length >= FILTER_FROM && (failed.length > 0 || edits.length > 0);
  const filtered = filter === "failed" ? failed : filter === "edits" ? edits : entries;
  const hidden = live && !all && filter === "all" ? Math.max(0, filtered.length - LIVE_STEPS) : 0;
  const shown = hidden ? filtered.slice(hidden) : filtered;
  const openStep = (item: AgentTraceItem) => onOpen(item, entries);
  const chip = (value: Filter, label: string) => <Button className={`work-filter${filter === value ? " is-on" : ""}`}
    aria-pressed={filter === value} onClick={() => setFilter(value)}><span>{label}</span></Button>;
  return <AgentDetails traceKey={traceKey} className={`work-card is-${outcome.tone}`} auto={open} kept={kept}
    dataTraceAnchor={anchor.anchor} dataTraceOrdinal={anchor.ordinal} dataTraceOrdinalEnd={anchor.ordinalFromEnd}>
    <summary className="work-head">
      <ToneMark tone={outcome.tone} />
      <span className="work-head-copy">
        <span className="work-title">{outcome.title}</span>
        {detail ? <span className="work-detail">{detail}</span> : null}
      </span>
      {entries.length > 0 && <ChevronRight className="work-chevron" size={16} aria-hidden="true" />}
    </summary>
    {entries.length > 0 && <div className="work-body" aria-live="off">
      {filters && <div className="work-filters" role="group" aria-label={t("work.stepsAria")}>
        {chip("all", t("work.filterAll"))}
        {failed.length > 0 && chip("failed", t("work.filterFailed", { n: failed.length }))}
        {edits.length > 0 && chip("edits", t("work.filterEdits", { n: edits.length }))}
      </div>}
      {hidden > 0 && <Button className="work-earlier" onClick={() => setAll(true)}>{t("work.earlier", { n: hidden })}</Button>}
      <ol className="work-steps" aria-label={t("work.stepsAria")}>
        {shown.map((item, index) => <StepRow key={`${filter}:${hidden + index}`} item={item} verified={verified} onOpen={openStep} />)}
      </ol>
    </div>}
  </AgentDetails>;
}
