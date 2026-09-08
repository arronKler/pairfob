/**
 * Optimistic echo for the guided pane.
 *
 * A guided pane is a snapshot, so a typed character only appears after a
 * mutation and a pane read have both come back — a whole round trip of a screen
 * that does not react. This holds the characters we can safely predict and shows
 * them dimmed until the real snapshot arrives.
 *
 * It is display only. Nothing here sends, replays or reorders anything: the
 * prediction is always discarded in favour of what the runtime reported, and it
 * expires on its own if no read arrives.
 */

/** Never let a prediction outlive the read that should have replaced it. */
export const ECHO_TIMEOUT_MS = 1_200;
/** Long enough to see the undone characters leave, short enough not to lag. */
export const ECHO_ROLLBACK_MS = 120;

type Echo = {
  paneId: string;
  /** Characters typed but not yet seen in a snapshot. */
  pending: string;
  /** Characters the runtime contradicted, on their way out. */
  rollback: string;
  /** Snapshot the prediction was made against; an identical one proves nothing. */
  base: string;
};

const empty: Echo = { paneId: "", pending: "", rollback: "", base: "" };
let echo: Echo = empty;
let expiry = 0;
let rollbackTimer = 0;
let onChange: (() => void) | null = null;

/** term.ts registers the in-place repaint; nothing else observes this module. */
export function setEchoObserver(observer: (() => void) | null): void {
  onChange = observer;
}

function changed(): void {
  onChange?.();
}

/**
 * Only text whose effect on the screen is obvious. A control key's meaning
 * belongs to whatever TUI is running — an arrow may move a cursor, redraw a menu
 * or do nothing — so those are never predicted.
 */
export function isPredictable(token: string): boolean {
  if (token.length !== 1) return false;
  const code = token.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

function arm(paneId: string, base: string): void {
  if (echo.paneId !== paneId) echo = { paneId, pending: "", rollback: "", base };
  window.clearTimeout(expiry);
  expiry = window.setTimeout(() => {
    // No read covered the prediction. Drop it rather than let it pass for truth.
    if (!echo.pending) return;
    echo = { ...echo, pending: "" };
    changed();
  }, ECHO_TIMEOUT_MS);
}

/** Predict a batch of SendKeys tokens. Anything unpredictable clears the buffer. */
export function predictKeys(paneId: string, keys: readonly string[], base: string): void {
  for (const key of keys) {
    if (isPredictable(key)) {
      arm(paneId, base);
      echo = { ...echo, pending: echo.pending + key };
      continue;
    }
    if (key === "backspace" && echo.paneId === paneId && echo.pending) {
      arm(paneId, base);
      echo = { ...echo, pending: echo.pending.slice(0, -1) };
      continue;
    }
    // Backspace with nothing predicted would have to guess at the runtime's own
    // characters, and every other token is a TUI's business.
    discard();
  }
  changed();
}

/** Predict streamed text; a control character ends the prediction. */
export function predictText(paneId: string, text: string, base: string): void {
  for (const character of text) {
    if (!isPredictable(character)) {
      discard();
      changed();
      return;
    }
    arm(paneId, base);
    echo = { ...echo, pending: echo.pending + character };
  }
  changed();
}

/** What to draw after the caret, and whether it is being undone. */
export function echoGhost(paneId: string): { text: string; rollback: boolean } {
  if (echo.paneId !== paneId) return { text: "", rollback: false };
  if (echo.rollback) return { text: echo.rollback, rollback: true };
  return { text: echo.pending, rollback: false };
}

/**
 * A snapshot arrived: it is the truth. Returns true when the prediction was not
 * borne out, in which case the undone characters fade instead of vanishing
 * silently — a wrong guess should be visible.
 */
export function settleEcho(paneId: string, texts: readonly string[], hash: string): boolean {
  if (echo.paneId !== paneId || !echo.pending) return false;
  // The same screen we predicted against says nothing either way; keep waiting,
  // and let the timeout be what ends an unanswered prediction.
  if (hash && hash === echo.base) return false;
  const pending = echo.pending;
  window.clearTimeout(expiry);
  const caret = [...texts].reverse().find((line) => line.trim()) ?? "";
  const confirmed = caret.trimEnd().endsWith(pending);
  echo = { paneId, pending: "", rollback: confirmed ? "" : pending, base: hash };
  if (!confirmed) {
    window.clearTimeout(rollbackTimer);
    rollbackTimer = window.setTimeout(() => {
      echo = { ...echo, rollback: "" };
      changed();
    }, ECHO_ROLLBACK_MS);
  }
  return !confirmed;
}

/** Forget the prediction without claiming anything about the screen. */
export function discard(): void {
  window.clearTimeout(expiry);
  window.clearTimeout(rollbackTimer);
  echo = empty;
}

export function resetEcho(): void {
  discard();
  changed();
}
