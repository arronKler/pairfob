import {
  Check, FileText, GitBranch, Globe, ListChecks, MessageCircleQuestionMark, Pencil, Plug, Search,
  Sparkles, Terminal, Wrench, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { categoryLabel, groupSteps, stepCategory, stepObject, stepState, type StepCategory, type StepGroup } from "../../../lib/agent-trace-steps";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { MOTION_MS, motionMs, playMove } from "../../../shared/ui/dom/motion";
import { arrivedFrom, seenSteps, type StepsSeen } from "./step-arrivals";
import { useTurned } from "./use-turned";

const CATEGORY_ICON: Record<StepCategory, LucideIcon> = {
  read: FileText, search: Search, edit: Pencil, command: Terminal, web: Globe, subtask: GitBranch,
  plan: ListChecks, question: MessageCircleQuestionMark, mcp: Plug, think: Sparkles, other: Wrench,
};

export type StepArrivals = {
  /** Steps from this index on joined a list that was already showing. */
  from: number;
  /** Rows the newcomers pushed out of a full window, kept for the length of the move. */
  pushed: { from: number; to: number } | null;
  /** Counts the pushes, so each one moves the list once. */
  move: number;
};

/**
 * Follows one card's list of steps across repaints (`step-arrivals`). The
 * answer is kept until the list changes again, so a repaint in between (the
 * elapsed time ticks every second) leaves the newcomer's entrance alone.
 */
export function useStepArrivals(steps: readonly AgentTraceItem[], hidden: number, scope: string): StepArrivals {
  const [, redraw] = useState(0);
  const state = useRef<StepArrivals & { seen: StepsSeen; hidden: number } | null>(null);
  state.current ??= { seen: seenSteps(steps, scope), hidden, from: Infinity, pushed: null, move: 0 };
  const s = state.current;
  if (s.seen.scope !== scope || s.seen.count !== steps.length || s.hidden !== hidden) {
    const from = arrivedFrom(s.seen, steps, scope);
    const arrived = from < steps.length;
    s.from = arrived ? from : Infinity;
    // Only the rows that were on screen leave; a burst of steps does not parade the ones nobody saw.
    const to = Math.min(hidden, s.seen.count);
    s.pushed = arrived && to > s.hidden && motionMs(MOTION_MS.panel) > 0 ? { from: s.hidden, to } : null;
    if (s.pushed) s.move += 1;
    s.seen = seenSteps(steps, scope);
    s.hidden = hidden;
  }
  const move = s.move;
  useEffect(() => {
    if (!state.current?.pushed) return;
    const timer = window.setTimeout(() => {
      if (state.current) state.current.pushed = null;
      redraw((count) => count + 1);
    }, motionMs(MOTION_MS.panel));
    return () => window.clearTimeout(timer);
  }, [move]);
  return s;
}

function StepRow({ item, verified, arriving = false, onOpen }: {
  item: AgentTraceItem; verified: boolean; arriving?: boolean; onOpen: (item: AgentTraceItem) => void;
}) {
  const category = stepCategory(item);
  const Icon = CATEGORY_ICON[category];
  const object = stepObject(item);
  const state = item.type === "tool" ? stepState(item, verified) : null;
  // A result that came in on this row pops; a row drawn with its result does not.
  const settled = useTurned(state !== null && state !== "running");
  const row = arriving ? "is-arriving" : undefined;
  if (item.type === "assistant") {
    // A finding is the agent speaking, so it is drawn as a message of its own
    // outside the card; the card never reaches this branch.
    return null;
  }
  const stateLabel = state ? t(`work.state.${state}`) : "";
  const aria = state ? t("work.stepAria", { category: categoryLabel(category), object, state: stateLabel }) : `${categoryLabel(category)} ${object}`;
  const mark = `work-step-state${settled ? " pop-in" : ""}`;
  return <li className={row}><Button className={`work-step is-${category}${state ? ` is-${state}` : ""}`} aria-label={aria}
    title={category === "subtask" ? t("work.subtaskHidden") : undefined} onClick={() => onOpen(item)}>
    <Icon className="work-step-icon" size={15} aria-hidden="true" />
    <span className={`work-step-text${item.type === "thinking" ? " is-prose" : ""}`}>{object || categoryLabel(category)}</span>
    {state === "running" ? <Spinner className="work-step-state" />
      : state === "error" ? <X className={mark} size={15} aria-hidden="true" />
      : state === "done" ? <Check className={mark} size={15} aria-hidden="true" />
      : state === "ended" ? <span className="work-step-state work-dot" aria-hidden="true" /> : null}
  </Button></li>;
}

/**
 * A run of same-kind settled tools as one row: how many, and what kind. The
 * press opens the run's first step, and its own chevron stands it down again,
 * so a long stretch of reads or greps takes one line instead of one each.
 */
function FoldedRow({ group, verified, arriving, onOpen }: {
  group: StepGroup; verified: boolean; arriving?: boolean; onOpen: (item: AgentTraceItem, steps: AgentTraceItem[]) => void;
}) {
  const Icon = CATEGORY_ICON[group.category];
  const [open, setOpen] = useState(false);
  const label = t("work.folded", { category: categoryLabel(group.category), n: group.steps.length });
  // What the run touched: the first two targets say more than the category the
  // icon already gives, and the count closes the row.
  const preview = group.steps.map((step) => stepObject(step)).filter(Boolean).slice(0, 2).join(" · ");
  const count = t("work.foldedCount", { n: group.steps.length });
  return <li className={`work-folded is-${group.category}${arriving ? " is-arriving" : ""}${open ? " is-open" : ""}`}>
    <Button className="work-step work-folded-head" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
      <Icon className="work-step-icon" size={15} aria-hidden="true" />
      <span className="work-step-text">{preview || categoryLabel(group.category)}</span>
      <span className="work-folded-count">{count}</span>
    </Button>
    {open && <ol className="work-steps work-folded-steps">
      {group.steps.map((step, index) => <StepRow key={index} item={step} verified={verified} onOpen={(item) => onOpen(item, group.steps)} />)}
    </ol>}
  </li>;
}

/**
 * A card's steps from `hidden` on. A step that joins fades in (`arrivals.from`).
 * When it pushes the first rows out of a full window, the list moves up by
 * their height with those rows still on it, so the reader sees which way the
 * work went. The card's box is final from the first frame: only the rows travel,
 * inside a window that clips them, and the transcript below does not move twice.
 */
export function StepList({ steps, hidden, listKey, breaks = [], folds = true, arrivals, verified, onOpen }: {
  steps: readonly AgentTraceItem[]; hidden: number;
  /** Tells one filter's rows from another's. */
  listKey: string;
  /** Row indices where a finding sat between steps, so no run folds across one. */
  breaks?: readonly number[];
  /** A running turn draws every step as itself; a finished one folds its runs. */
  folds?: boolean;
  arrivals: StepArrivals; verified: boolean; onOpen: (item: AgentTraceItem, steps?: AgentTraceItem[]) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const pushed = useRef<HTMLOListElement>(null);
  // A list mounted with a push already counted was not on screen for it.
  const moved = useRef(arrivals.move);
  useLayoutEffect(() => {
    if (moved.current === arrivals.move) return;
    moved.current = arrivals.move;
    const shift = pushed.current?.offsetHeight ?? 0;
    const node = track.current;
    if (!node || !shift) return;
    playMove(node, [{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], MOTION_MS.panel);
  }, [arrivals.move]);
  const gone = arrivals.pushed;
  // Rows are grouped after the window is cut, so `hidden` still counts the steps
  // the reader asked to reveal, and a group's first step keeps its own arrival.
  // A chosen filter shows exactly what it named, one row each; the unfiltered
  // list folds its runs, in the window and out of it alike, because the window
  // is measured in the same rows.
  const visible = steps.slice(hidden);
  const groups = listKey === "all" && folds
    ? groupSteps(visible, breaks.map((at) => at - hidden).filter((at) => at >= 0))
    : visible.map((item) => ({ items: [item], steps: [item], category: stepCategory(item) }));
  const firstOf = new Map(groups.map((group) => [group, visible.indexOf(group.steps[0]!)]));
  // `arrivals.from` counts steps in the whole list, so a row's own step index is
  // the window offset plus its place among the rows drawn.
  const arrived = (row: number): boolean => hidden + row >= arrivals.from;
  const pushedGroups = gone ? groupSteps(steps.slice(gone.from, gone.to)) : [];
  return <div className="work-steps-window">
    <div ref={track} className="work-steps-track">
      {gone && <ol ref={pushed} className="work-steps work-steps-pushed" aria-hidden="true" inert>
        {pushedGroups.map((group, index) => group.steps.length > 1
          ? <FoldedRow key={`${listKey}:pushed:${index}`} group={group} verified={verified} onOpen={() => undefined} />
          : <StepRow key={`${listKey}:pushed:${index}`} item={group.items[0]!} verified={verified} onOpen={onOpen} />)}
      </ol>}
      <ol className="work-steps" aria-label={t("work.stepsAria")}>
        {groups.map((group, index) => {
          return group.steps.length > 1
            ? <FoldedRow key={`${listKey}:${hidden + (firstOf.get(group) ?? index)}`} group={group} verified={verified}
              arriving={arrived(firstOf.get(group) ?? index)} onOpen={(item) => onOpen(item, group.steps)} />
            : <StepRow key={`${listKey}:${hidden + (firstOf.get(group) ?? index)}`} item={group.items[0]!} verified={verified}
              arriving={arrived(firstOf.get(group) ?? index)} onOpen={onOpen} />;
        })}
      </ol>
    </div>
  </div>;
}
