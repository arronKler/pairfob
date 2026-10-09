import { liveSession } from "../../computers/catalog-store";
import { currentScreen } from "../../../app/navigation-store";
import { isFullTerminal, livePaneHash, livePaneText, openPaneId } from "../session-store";
import { reportMutationError } from "../../connection/mutations";
import { confirmPaneChange } from "../../connection/pane-change-confirmation";
import { publishPanePagePerf } from "../../connection/pane-page-perf";
import { requestPaneRefresh } from "../../connection/refresh-request";
import { clearNotice } from "../../../app/notices-store";
import { markPaneSubmitted } from "../../dashboard/catalog-store";
import { tryAppRoot } from "../../../app/dom-root";
import { haptic } from "../../../lib/dom";
import { encodeTerminalKey, requiresTerminalText } from "../keypad/terminal-keys";
import { withModifiers } from "../keypad/keypad";
import { discard, predictKeys } from "./echo";
import { flyKeyToCursor } from "./key-flight";
import { bindPadPress } from "../keypad/key-press";
import { liveOrder, registerLivePath } from "./live-order";

export { REPEAT_DELAY_MS, REPEAT_EVERY_MS } from "../keypad/key-press";

/**
 * The flight target is measured only while a pad key is pressed — long after
 * browser boot owns `#app`. Resolve it lazily at press time so importing this
 * controller (the settings/actions chain reaches it in a headless process)
 * never touches the DOM. Returns null before boot owns a root.
 */
function keyFlightTarget(): HTMLElement | null {
  const app = tryAppRoot();
  if (!app) return null;
  return app.querySelector<HTMLElement>(".term") ?? app.querySelector<HTMLElement>(".full-terminal-host");
}

/** rpc.schema.json caps SendKeys.keys at 32 entries. */
const MAX_BATCH = 32;
const BATCH_MS = 55;

let pending: string[] = [];
let pendingPane = "";
let batchTimer: number | null = null;
let pendingSession: ReturnType<typeof liveSession> = null;
let queueGeneration = 0;
let flushing: Promise<void> | null = null;
const pagePending = new Map<string, { up: number; down: number }>();
let pagePendingRevision = 0;
const pagePendingListeners = new Set<() => void>();

export function pagePendingStoreRevision(): number {
  return pagePendingRevision;
}

export function subscribePagePending(listener: () => void): () => void {
  pagePendingListeners.add(listener);
  return () => {
    pagePendingListeners.delete(listener);
  };
}

export function pagePendingCounts(paneId = openPaneId()): { up: number; down: number } {
  return pagePending.get(paneId) ?? { up: 0, down: 0 };
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function syncPagePending(): void {
  pagePendingRevision += 1;
  for (const listener of pagePendingListeners) listener();
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
 * Keys are one of the paths a guided session is typed on (`live-order`): a key
 * must not be written before a character typed ahead of it, nor a character
 * before a key this queue is still holding.
 */
const writtenWaiters: Array<() => void> = [];

function resolveWritten(): void {
  if (pending.length) return;
  for (const resolve of writtenWaiters.splice(0)) resolve();
}

registerLivePath("keys", {
  unsent: () => pending.length > 0,
  written: () => pending.length ? new Promise<void>((resolve) => writtenWaiters.push(resolve)) : Promise.resolve(),
});

/** Run `send` for the pane the key was pressed for, in its turn; a pane that changed meanwhile gets nothing. */
function inTurn(send: () => void): void {
  const session = liveSession();
  const paneId = openPaneId();
  liveOrder.submit("keys", () => {
    if (liveSession() === session && openPaneId() === paneId) send();
  });
}

/**
 * Held arrow keys would otherwise be one RPC round trip and one full pane read
 * per repeat. Coalesce into a single SendKeys so the runtime sees the same key
 * order the thumb produced. The queue is bound to the pane it was typed for so
 * a pane switch mid-batch can never deliver keys to the wrong terminal.
 */
export function queueKey(key: string, source?: HTMLElement | null): void {
  if (!liveSession() || !openPaneId()) return;
  // The modifiers armed when the key was pressed, not when its turn comes.
  const mapped = withModifiers(key);
  if (!mapped.length) return;
  inTurn(() => writeKeys(mapped, source));
}

function writeKeys(mapped: string[], source?: HTMLElement | null): void {
  if (pendingPane && (pendingPane !== openPaneId() || pendingSession !== liveSession())) dropQueuedKeys();
  const wasEmpty = pending.length === 0;
  pendingPane = openPaneId();
  pendingSession = liveSession();
  pending.push(...mapped);
  haptic(4, source);
  // Fired here rather than on pointerdown: the spark should only promise a key
  // that is actually on its way to the PTY.
  flyKeyToCursor(source, keyFlightTarget(), mapped[mapped.length - 1]);
  predictKeys(openPaneId(), mapped, livePaneHash());
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

/** Resolve only after every queued batch in this ownership generation settles. */
export function flushKeys(): Promise<void> {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (pendingPane && (pendingSession !== liveSession() || pendingPane !== openPaneId())) {
    dropQueuedKeys();
  }
  if (flushing) return flushing;
  if (!pending.length) return Promise.resolve();
  const session = pendingSession;
  const paneId = pendingPane;
  if (!session || !paneId) {
    dropQueuedKeys();
    return Promise.resolve();
  }
  const generation = queueGeneration;
  const ownsQueue = () => queueGeneration === generation && liveSession() === session && openPaneId() === paneId;
  // Publish the shared promise before dispatch: a transport may throw synchronously.
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  flushing = completion;
  void drain(session).then(resolve, reject);
  return completion;

  async function drain(session: NonNullable<ReturnType<typeof liveSession>>): Promise<void> {
    try {
      while (ownsQueue() && pending.length) {
        const raw = requiresTerminalText(pending[0]);
        let count = 1;
        while (count < Math.min(pending.length, MAX_BATCH) && requiresTerminalText(pending[count]) === raw) count++;
        const keys = pending.splice(0, count);
        // The batch is written below in this same turn: what waited for it may follow.
        resolveWritten();
        const mutationStartedAt = nowMs();
        // Start the ordered read behind the write without another network round trip.
        const mutation = raw
          ? session.sendText(paneId, keys.map(key => encodeTerminalKey(key)).join(""))
          : session.sendKeys(paneId, keys, { intent: "pad" });
        const read = requestPaneRefresh({ notBefore: mutationStartedAt, postponeFallback: true });
        void read.catch(() => undefined);
        await mutation;
        if (!ownsQueue()) return;
        if (keys.includes("enter")) markPaneSubmitted(paneId);
        clearNotice();
        await read;
      }
    } catch (error) {
      // An old pane/session must never discard or report against a newer queue.
      if (ownsQueue()) {
        dropQueuedKeys();
        await reportMutationError(session, error);
      }
    } finally {
      if (queueGeneration === generation) flushing = null;
    }
  }
}

export function dropQueuedKeys(): void {
  queueGeneration += 1;
  flushing = null;
  pendingSession = null;
  pending = [];
  pendingPane = "";
  resolveWritten();
  // Keys that were never sent must not keep showing as if they had been.
  discard();
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

/** Repeat a pad key without one haptic per repeat. Caps at the SendKeys batch. */
export function queueRepeats(key: string, count: number, source?: HTMLElement | null): void {
  const mapped = withModifiers(key);
  if (!mapped.length) return;
  inTurn(() => writeRepeats(mapped, count, source));
}

function writeRepeats(mapped: string[], count: number, source?: HTMLElement | null): void {
  const n = Math.min(Math.max(count, 1), MAX_BATCH);
  for (let i = 0; i < n; i++) {
    if (!liveSession() || !openPaneId()) return;
    if (pendingPane && (pendingPane !== openPaneId() || pendingSession !== liveSession())) dropQueuedKeys();
    pendingPane = openPaneId();
    pendingSession = liveSession();
    pending.push(...mapped);
    if (i === 0) {
      haptic(4, source);
      flyKeyToCursor(source, keyFlightTarget(), mapped[mapped.length - 1]);
    }
    if (pending.length >= MAX_BATCH) void flushKeys();
    else if (batchTimer === null) batchTimer = window.setTimeout(() => void flushKeys(), BATCH_MS);
  }
}

/** What a page key's turn did: nothing (the pane was left), or the write and what the screen read before it. */
type PageWrite = {
  baselineHash: string;
  baselineText: string;
  startedAt: number;
  mutation: Promise<unknown>;
  initialRead: ReturnType<typeof requestPaneRefresh> | null;
};

/**
 * A page key's turn in the session's order (`live-order`). It writes directly,
 * so it waits for what was typed and pressed before it, and what is typed after
 * it waits until it has written: a PageUp pressed between two characters stays
 * between them. Undefined when the turn never came (the pane changed).
 */
function pageTurn(write: () => PageWrite | null): Promise<PageWrite | null | undefined> {
  return new Promise((resolve) => {
    liveOrder.submit(null, async () => {
      // Keys already queued are acknowledged first, as they always were before a page.
      await flushKeys().catch(() => undefined);
      resolve(write());
    }, () => resolve(undefined));
  });
}

/**
 * Herdr pane.send_keys rejects pageup/pagedown (host scrollback owns them).
 * Write the xterm CSI sequence into the PTY instead so alt-screen TUIs page.
 */
export async function sendPage(direction: "up" | "down"): Promise<void> {
  const session = liveSession();
  if (!session || !openPaneId()) return;
  const paneId = openPaneId();
  const clickedAt = nowMs();
  const finishPending = beginPagePending(paneId, direction);
  haptic(4);
  let mutationStartedAt: number | null = null;
  let mutationAckAt: number | null = null;
  try {
    const written = await pageTurn(() => {
      if (liveSession() !== session || openPaneId() !== paneId || currentScreen() !== "pane" || isFullTerminal()) return null;
      const baselineHash = livePaneHash();
      const baselineText = livePaneText();
      const startedAt = nowMs();
      let initialRead: PageWrite["initialRead"] = null;
      let mutation: Promise<unknown>;
      try {
        // The browser sends these frames in order and the daemon drains each
        // session's RPC queue serially. Start the read immediately behind the
        // mutation so a high-latency connection pays one round trip, while the
        // hash confirmation below still catches a stale runtime snapshot.
        mutation = session.sendText(paneId, direction === "up" ? "\u001b[5~" : "\u001b[6~");
        initialRead = requestPaneRefresh({ notBefore: startedAt, postponeFallback: true });
      } catch (error) {
        mutation = Promise.reject(error);
      }
      return { baselineHash, baselineText, startedAt, mutation, initialRead };
    });
    if (!written) {
      const finishedAt = nowMs();
      publishPanePagePerf({
        direction, result: "cancelled", attempts: 0,
        clickToMutationStartMs: finishedAt - clickedAt,
        mutationRttMs: null, clickToAckMs: null, ackToFirstReadMs: null, clickToChangeMs: null,
        totalMs: finishedAt - clickedAt,
      });
      return;
    }
    const { baselineHash, baselineText, initialRead } = written;
    mutationStartedAt = written.startedAt;
    try {
      await written.mutation;
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
        isCurrent: () => liveSession() === session && openPaneId() === paneId && currentScreen() === "pane" && !isFullTerminal(),
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

/** Press-and-hold auto-repeat, mirroring a physical key. */
export function bindKeyPress(element: HTMLElement, key: string, repeatable: boolean): { stop: () => void } {
  return bindPadPress(element, () => queueKey(key, element), { repeat: repeatable });
}
