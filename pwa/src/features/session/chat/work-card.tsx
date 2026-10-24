import { Check, ChevronRight, CircleSlash, TriangleAlert, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { AgentTraceItem, AgentTraceModel } from "../../../lib/operations";
import { formatElapsed, groupSteps, stepCategory, stepState, type TurnOutcome, type TurnTone } from "../../../lib/agent-trace-steps";
import { Button, Spinner, Swap } from "../../../shared/ui/primitives";
import { daemonNow } from "../../../lib/agent-trace-clock";
import type { DetailsState } from "./agent-chat-stream";
import { modelSummary, TurnModelDetails } from "./turn-models";
import { AgentDetails } from "./agent-details";
import { StepList, useStepArrivals } from "./work-steps";
import { useTurned } from "./use-turned";

/** Live cards show the latest steps; earlier ones stay one tap away. */
const LIVE_STEPS = 4;
/** Long cards offer failed/edited filters. */
const FILTER_FROM = 9;
type Filter = "all" | "failed" | "edits";

/** The turn's state at a glance. A result that arrives while the card is on screen pops in over the spinner it replaces. */
function ToneMark({ tone }: { tone: TurnTone }) {
  const settled = useTurned(tone !== "running");
  if (tone === "running") return <Spinner className="work-tone" />;
  const Icon = tone === "done" ? Check : tone === "error" ? X : tone === "waiting" ? TriangleAlert
    : tone === "interrupted" ? CircleSlash : tone === "stale" ? WifiOff : null;
  const mark = `work-tone${settled ? " pop-in" : ""}`;
  return Icon ? <Icon className={mark} size={16} aria-hidden="true" /> : <span className={`${mark} work-dot`} aria-hidden="true" />;
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
 * `historyLoads` counts the older pages put in front of the transcript: when it
 * changes, history moved in front of the card and none of its steps are new.
 */
export function WorkCard({ traceKey, entries, outcome, live, follow = true, kept, verified, span, models, anchor, historyLoads = 0, breaks, onOpen }: {
  traceKey: string; entries: AgentTraceItem[]; outcome: TurnOutcome; live: boolean; follow?: boolean; kept?: DetailsState;
  /** Row indices a finding interrupted, so a run never folds across one. */
  breaks?: readonly number[];
  verified: boolean; models?: AgentTraceModel[]; span?: { start?: number; end?: number };
  anchor: { anchor: string; ordinal: number; ordinalFromEnd: number }; historyLoads?: number; onOpen: OpenStep;
}) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const open = useHeldOpen(live, follow);
  const elapsed = useElapsed(span?.start, span?.end, live && outcome.tone === "running");
  const modelText = modelSummary(models);
  const detail = [elapsed, modelText, outcome.detail].filter(Boolean).join(" · ");
  const failed = entries.filter((item) => item.type === "tool" && stepState(item, verified) === "error");
  const edits = entries.filter((item) => item.type === "tool" && stepCategory(item) === "edit");
  const filters = entries.length >= FILTER_FROM && (failed.length > 0 || edits.length > 0);
  const filtered = filter === "failed" ? failed : filter === "edits" ? edits : entries;
  // A running card draws every step as itself: the reader is watching the work
  // arrive, and a run that folded under them would hide steps they just saw. A
  // finished card folds its runs, and its window holds four rows, so hiding
  // "four steps" never leaves two rows where there were three.
  //
  // The window is measured in rows but cut from the raw steps the list receives,
  // so the count is translated: the rows dropped are whole groups, and the steps
  // those groups hold are what the list has to drop. A group is never split, and
  // the disclosure says the number of steps it reveals.
  const foldsNow = !live && filter === "all";
  const groups = foldsNow ? groupSteps(filtered, breaks) : null;
  let hidden = 0;
  if (!all && filter === "all") {
    if (groups) {
      const drop = Math.max(0, groups.length - LIVE_STEPS);
      hidden = groups.slice(0, drop).reduce((count, group) => count + group.steps.length, 0);
    } else {
      hidden = Math.max(0, filtered.length - LIVE_STEPS);
    }
  }
  // Followed here, above the details' own key: the card's first tool renames it and remounts its rows.
  const arrivals = useStepArrivals(filtered, hidden, `${filter}:${all ? "all" : "latest"}:${historyLoads}`);
  const openStep = (item: AgentTraceItem) => onOpen(item, entries);
  const chip = (value: Filter, label: string) => <Button className={`work-filter${filter === value ? " is-on" : ""}`}
    aria-pressed={filter === value} onClick={() => setFilter(value)}><span>{label}</span></Button>;
  const body = entries.length > 0 || models !== undefined;
  return <AgentDetails traceKey={traceKey} className={`work-card is-${outcome.tone}`} auto={open} kept={kept}
    dataTraceAnchor={anchor.anchor} dataTraceOrdinal={anchor.ordinal} dataTraceOrdinalEnd={anchor.ordinalFromEnd}
    headClassName="work-head" head={<>
      <ToneMark tone={outcome.tone} />
      <span className="work-head-copy">
        {/* The words swap when the turn changes state. A step count and the elapsed second are the same state, replaced in place. */}
        <Swap on={outcome.tone} className="work-title">{outcome.title}</Swap>
        {detail ? <Swap on={outcome.tone} className={`work-detail${modelText ? " has-model" : ""}`} title={detail}>
          {modelText ? <>
            {elapsed && <span className="work-meta-fixed">{elapsed}{" · "}</span>}
            <span className="work-meta-model">{models?.length === 1 ? models[0].model : modelText}</span>
            {models?.length === 1 && models[0].effort && <span className="work-meta-fixed">{" · "}{models[0].effort}</span>}
            {outcome.detail && <span className="work-meta-outcome">{" · "}{outcome.detail}</span>}
          </> : detail}
        </Swap> : null}
      </span>
      {body && <ChevronRight className="work-chevron" size={16} aria-hidden="true" />}
    </>}>
    {body && <div className="work-body" aria-live="off">
      {models !== undefined && <TurnModelDetails models={models} />}
      {filters && <div className="work-filters" role="group" aria-label={t("work.stepsAria")}>
        {chip("all", t("work.filterAll"))}
        {failed.length > 0 && chip("failed", t("work.filterFailed", { n: failed.length }))}
        {edits.length > 0 && chip("edits", t("work.filterEdits", { n: edits.length }))}
      </div>}
      {hidden > 0 && <Button className="work-earlier" onClick={() => setAll(true)}>{t("work.earlier", { n: hidden })}</Button>}
      <StepList steps={filtered} hidden={hidden} listKey={filter} breaks={filter === "all" ? breaks : undefined}
        folds={foldsNow}
                arrivals={arrivals} verified={verified} onOpen={openStep} />
    </div>}
  </AgentDetails>;
}
