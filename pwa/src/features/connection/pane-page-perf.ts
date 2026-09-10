import type { PaneChangeConfirmation } from "./pane-change-confirmation";

export const PANE_PAGE_PERF_EVENT = "pairfob:pane-page-perf";

const PERF_DEBUG_KEY = "pairfob:terminalPerf";
let sequence = 0;

export type PanePagePerfSample = {
  sequence: number;
  direction: "up" | "down";
  result: PaneChangeConfirmation["result"] | "error";
  attempts: number;
  clickToMutationStartMs: number;
  mutationRttMs: number | null;
  clickToAckMs: number | null;
  ackToFirstReadMs: number | null;
  clickToChangeMs: number | null;
  totalMs: number;
};

type PanePagePerfInput = Omit<PanePagePerfSample, "sequence">;

/** Publish one bounded, content-free paging sample for browser QA. */
export function publishPanePagePerf(input: PanePagePerfInput): PanePagePerfSample {
  const sample = { ...input, sequence: ++sequence };
  if (typeof document !== "undefined") {
    const EventConstructor = document.defaultView?.CustomEvent;
    if (EventConstructor) document.dispatchEvent(new EventConstructor(PANE_PAGE_PERF_EVENT, { detail: sample }));
  }
  try {
    if (localStorage.getItem(PERF_DEBUG_KEY) === "1") console.info("[Pairfob pane page perf]", sample);
  } catch {
    /* storage can be unavailable in private mode */
  }
  return sample;
}
