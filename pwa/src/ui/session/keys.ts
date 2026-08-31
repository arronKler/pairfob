import { liftTap, type Block } from "../../lib/prompt";
import { reportMutationError } from "../../mutations";
import { requestPaneRefresh } from "../../pane-refresh-request";
import { clearNotice, haptic, markPaneSubmitted, state } from "../../state";
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
  pendingPane = state.paneId;
  pending.push(...mapped);
  haptic(4);
  if (pending.length >= MAX_BATCH) {
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
    await session.sendKeys(paneId, keys, { intent: "pad" });
    if (keys.includes("enter")) markPaneSubmitted(paneId);
    clearNotice();
    await requestPaneRefresh();
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
  await flushKeys();
  haptic(4);
  try {
    await session.sendText(paneId, direction === "up" ? "\u001b[5~" : "\u001b[6~");
    clearNotice();
    await requestPaneRefresh();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

/** One-shot send that bypasses the batch, for keys that carry a prompt guard. */
export async function sendGuarded(keys: string[], intent: "dialog" | "submit", expectedPrompt: string): Promise<void> {
  const session = state.live;
  if (!session || !state.paneId) return;
  const paneId = state.paneId;
  await flushKeys();
  try {
    await session.sendKeys(paneId, keys, { intent, expected_prompt: expectedPrompt });
    if (keys.includes("enter")) markPaneSubmitted(paneId);
    clearNotice();
    await requestPaneRefresh();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function answerPrompt(block: Block, index: number): Promise<void> {
  const spec = liftTap(block, index);
  if (!spec) return;
  haptic(10);
  await sendGuarded(spec.keys, "dialog", spec.expectedPrompt);
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
