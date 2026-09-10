/**
 * Memory for the two things a herd list has to make visible: which cards are
 * new to the list, and which agents just changed status. Both need to survive
 * across snapshot updates and component remounts. Keeping this history outside
 * the DOM lets React render the same attention window throughout an update.
 */

export type StatusMark = "" | "changed" | "done";

/** Covers the highlight sweep, so a repaint inside the window keeps the mark. */
const MARK_MS = 460;
const DISMISS_MS = 360;

export type HerdCard = { paneId: string; status: string };

export type HerdPaint = {
  /** Replay the card entrance: the list itself changed, not just its contents. */
  stagger: boolean;
  markOf: (paneId: string) => StatusMark;
  /** The completion hairline should sweep out instead of blinking away. */
  isDismissing: (paneId: string) => boolean;
  /** Panes that went working -> done on this paint, for a one-off acknowledgement. */
  completed: string[];
};

let shape = "";
let statuses = new Map<string, string>();
const marks = new Map<string, { until: number; done: boolean }>();
const dismissals = new Map<string, number>();

export function openHerdPaint(cards: HerdCard[], groupMode: string, at = Date.now()): HerdPaint {
  const signature = `${groupMode}\u0000${cards.map((card) => card.paneId).join("\u0000")}`;
  const stagger = signature !== shape;
  shape = signature;

  const completed: string[] = [];
  for (const card of cards) {
    const before = statuses.get(card.paneId);
    // A card seen for the first time enters with the list; it has not "changed".
    if (before === undefined || before === card.status) continue;
    const done = before === "working" && card.status === "done";
    marks.set(card.paneId, { until: at + MARK_MS, done });
    if (done) completed.push(card.paneId);
  }
  statuses = new Map(cards.map((card) => [card.paneId, card.status]));
  for (const [paneId, mark] of marks) if (mark.until <= at) marks.delete(paneId);
  for (const [paneId, until] of dismissals) if (until <= at) dismissals.delete(paneId);

  return {
    stagger,
    markOf: (paneId) => {
      const mark = marks.get(paneId);
      if (!mark) return "";
      return mark.done ? "done" : "changed";
    },
    isDismissing: (paneId) => dismissals.has(paneId),
    completed,
  };
}

/** The reader opened the pane and read the result, so the hairline earns an exit. */
export function noteCompletionAcknowledged(paneId: string, at = Date.now()): void {
  dismissals.set(paneId, at + DISMISS_MS);
}

/** Test seam: start from a list nobody has seen yet. */
export function resetHerdAttention(): void {
  shape = "";
  statuses = new Map();
  marks.clear();
  dismissals.clear();
}
