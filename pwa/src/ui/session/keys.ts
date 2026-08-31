import { reportMutationError } from "../../mutations";
import { confirmPaneChange } from "../../pane-change-confirmation";
import { publishPanePagePerf } from "../../pane-page-perf";
import { requestPaneRefresh } from "../../pane-refresh-request";
import { app, clearNotice, haptic, markPaneSubmitted, state } from "../../state";
import { withModifiers } from "../keypad";

/** rpc.schema.json caps SendKeys.keys at 32 entries. */
const MAX_BATCH = 32;
const BATCH_MS = 55;
export const REPEAT_DELAY_MS = 380;
export const REPEAT_EVERY_MS = 90;

let pending: string[] = [];
let pendingPane = "";
let batchTimer: number | null = null;
let flushing = false;
const pagePending = new Map<string, { up: number; down: number }>();

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function syncPagePending(root: ParentNode = app): void {
  const counts = pagePending.get(state.paneId) ?? { up: 0, down: 0 };
  const busy = counts.up + counts.down > 0;
  root.querySelectorAll<HTMLElement>(".full-terminal-scroll").forEach((rail) => {
    if (busy) rail.setAttribute("aria-busy", "true");
    else rail.removeAttribute("aria-busy");
  });
  for (const direction of ["up", "down"] as const) {
    root.querySelectorAll<HTMLElement>(`.scroll-page-${direction}`).forEach((button) => {
      const active = counts[direction] > 0;
      button.classList.toggle("is-pending", active);
      if (active) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    });
  }
}

function beginPagePending(paneId: string, direction: "up" | "down"): () => void {
  const counts = pagePending.get(paneId) ?? { up: 0, down: 0 };
  counts[direction] += 1;
  pagePending.set(paneId, counts);
  syncPagePending();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    counts[direction] = Math.max(0, counts[direction] - 1);
    if (counts.up + counts.down === 0) pagePending.delete(paneId);
    syncPagePending();
  };
}

/**
 * Held arrow keys would otherwise be one RPC round trip and one full pane read
 * per repeat. Coalesce into a single SendKeys so the runtime sees the same key
 * order the thumb produced. The queue is bound to the pane it was typed for so
 * a pane switch mid-batch can never deliver keys to the wrong terminal.
 */
export function queueKey(key: string): void {
  if (!state.live || !state.paneId) return;
  const mapped = withModifiers(key);
  if (!mapped.length) return;
  if (pendingPane && pendingPane !== state.paneId) dropQueuedKeys();
  const wasEmpty = pending.length === 0;
  pendingPane = state.paneId;
  pending.push(...mapped);
  haptic(4);
  if (pending.length >= MAX_BATCH) {
    void flushKeys();
    return;
  }
  // Do not add a fixed batching delay to the first physical key. Repeats that
  // arrive while its mutation is in flight are still coalesced behind it.
  if (wasEmpty && !flushing) {
    void flushKeys();
    return;
  }
  if (batchTimer === null) batchTimer = window.setTimeout(() => void flushKeys(), BATCH_MS);
}

export async function flushKeys(): Promise<void> {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (flushing || !pending.length) return;
  const session = state.live;
  const paneId = pendingPane;
  if (!session || !paneId || paneId !== state.paneId) {
    dropQueuedKeys();
    return;
  }
  const keys = pending.slice(0, MAX_BATCH);
  pending = pending.slice(keys.length);
  flushing = true;
  try {
    const mutationStartedAt = nowMs();
    // sendKeys writes its encrypted frame synchronously. Queueing PaneRead
    // immediately afterwards preserves daemon session order while avoiding a
    // second cross-region round trip after the mutation acknowledgement.
    const mutation = session.sendKeys(paneId, keys, { intent: "pad" });
    const read = requestPaneRefresh({ notBefore: mutationStartedAt, postponeFallback: true });
    await mutation;
    if (keys.includes("enter")) markPaneSubmitted(paneId);
    clearNotice();
    await read;
  } catch (error) {
    dropQueuedKeys();
    await reportMutationError(session, error);
  } finally {
    flushing = false;
    if (pending.length) void flushKeys();
  }
}

export function dropQueuedKeys(): void {
  pending = [];
  pendingPane = "";
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

/** Repeat a pad key without one haptic per repeat. Caps at the SendKeys batch. */
export function queueRepeats(key: string, count: number): void {
  const mapped = withModifiers(key);
  if (!mapped.length) return;
  const n = Math.min(Math.max(count, 1), MAX_BATCH);
  for (let i = 0; i < n; i++) {
    if (!state.live || !state.paneId) return;
    if (pendingPane && pendingPane !== state.paneId) dropQueuedKeys();
    pendingPane = state.paneId;
    pending.push(...mapped);
    if (i === 0) haptic(4);
    if (pending.length >= MAX_BATCH) void flushKeys();
    else if (batchTimer === null) batchTimer = window.setTimeout(() => void flushKeys(), BATCH_MS);
  }
}

/**
 * Herdr pane.send_keys rejects pageup/pagedown (host scrollback owns them).
 * Write the xterm CSI sequence into the PTY instead so alt-screen TUIs page.
 */
export async function sendPage(direction: "up" | "down"): Promise<void> {
  const session = state.live;
  if (!session || !state.paneId) return;
  const paneId = state.paneId;
  const clickedAt = nowMs();
  const finishPending = beginPagePending(paneId, direction);
  haptic(4);
  let mutationStartedAt: number | null = null;
  let mutationAckAt: number | null = null;
  try {
    await flushKeys();
    if (state.live !== session || state.paneId !== paneId || state.screen !== "pane" || state.fullTerminal) {
      const finishedAt = nowMs();
      publishPanePagePerf({
        direction, result: "cancelled", attempts: 0,
        clickToMutationStartMs: finishedAt - clickedAt,
        mutationRttMs: null, clickToAckMs: null, ackToFirstReadMs: null, clickToChangeMs: null,
        totalMs: finishedAt - clickedAt,
      });
      return;
    }
    const baselineHash = state.paneHash;
    const baselineText = state.paneText;
    mutationStartedAt = nowMs();
    let initialRead: ReturnType<typeof requestPaneRefresh> | null = null;
    try {
      // The browser sends these frames in order and the daemon drains each
      // session's RPC queue serially. Start the read immediately behind the
      // mutation so a high-latency connection pays one round trip, while the
      // hash confirmation below still catches a stale runtime snapshot.
      const mutation = session.sendText(paneId, direction === "up" ? "\u001b[5~" : "\u001b[6~");
      initialRead = requestPaneRefresh({ notBefore: mutationStartedAt, postponeFallback: true });
      await mutation;
    } catch (error) {
      void initialRead?.catch(() => undefined);
      const finishedAt = nowMs();
      publishPanePagePerf({
        direction, result: "error", attempts: 0,
        clickToMutationStartMs: mutationStartedAt - clickedAt,
        mutationRttMs: finishedAt - mutationStartedAt,
        clickToAckMs: null, ackToFirstReadMs: null, clickToChangeMs: null,
        totalMs: finishedAt - clickedAt,
      });
      await reportMutationError(session, error);
      return;
    }
    mutationAckAt = nowMs();
    clearNotice();
    let confirmation;
    try {
      confirmation = await confirmPaneChange({
        paneId,
        baselineHash,
        baselineText,
        mutationAckAt,
        initialRead: initialRead ?? undefined,
        read: requestPaneRefresh,
        isCurrent: () => state.live === session && state.paneId === paneId && state.screen === "pane" && !state.fullTerminal,
      });
    } catch {
      const finishedAt = nowMs();
      publishPanePagePerf({
        direction, result: "error", attempts: 0,
        clickToMutationStartMs: mutationStartedAt - clickedAt,
        mutationRttMs: mutationAckAt - mutationStartedAt,
        clickToAckMs: mutationAckAt - clickedAt,
        ackToFirstReadMs: null, clickToChangeMs: null,
        totalMs: finishedAt - clickedAt,
      });
      return;
    }
    const finishedAt = nowMs();
    publishPanePagePerf({
      direction,
      result: confirmation.result,
      attempts: confirmation.attempts,
      clickToMutationStartMs: mutationStartedAt - clickedAt,
      mutationRttMs: mutationAckAt - mutationStartedAt,
      clickToAckMs: mutationAckAt - clickedAt,
      ackToFirstReadMs: confirmation.firstReadStartedAt === null ? null : confirmation.firstReadStartedAt - mutationAckAt,
      clickToChangeMs: confirmation.changedAt === null ? null : confirmation.changedAt - clickedAt,
      totalMs: finishedAt - clickedAt,
    });
  } finally {
    finishPending();
  }
}

type RepeatHandle = { stop: () => void };

/** Press-and-hold auto-repeat, mirroring a physical key. */
export function bindKeyPress(element: HTMLElement, key: string, repeatable: boolean): RepeatHandle {
  let hold: number | null = null;
  let tick: number | null = null;
  const stop = () => {
    if (hold !== null) clearTimeout(hold);
    if (tick !== null) clearInterval(tick);
    hold = null;
    tick = null;
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    queueKey(key);
    if (!repeatable) return;
    stop();
    hold = window.setTimeout(() => {
      if (!element.isConnected) return;
      tick = window.setInterval(() => {
        // A background render can replace the pad mid-hold. The detached
        // button never receives pointerup, so the repeat must stop itself.
        if (!element.isConnected) {
          stop();
          return;
        }
        queueKey(key);
      }, REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"] as const) {
    element.addEventListener(type, stop);
  }
  element.addEventListener("click", (event) => {
    if (event.detail === 0) queueKey(key);
  });
  return { stop };
}
