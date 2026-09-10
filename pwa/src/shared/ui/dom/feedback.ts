/**
 * Press acknowledgement for shared gesture surfaces.
 *
 * Pure platform feedback: it reads `navigator` and the pressed element only, so
 * shared UI can acknowledge a gesture without importing application state.
 */

const TAP_ACK_MS = 120;

/**
 * iOS Safari has no Vibration API, so a phone that cannot buzz gets the same
 * acknowledgement as a visible flash on the control that was pressed.
 */
export function haptic(ms = 10, target?: HTMLElement | null): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(ms);
      return;
    } catch {
      /* fall through to the visual stand-in */
    }
  }
  tapAck(target);
}

/**
 * Stands in for a vibration the platform will not deliver. Restarts on every
 * call so auto-repeat shows each repeat instead of one held highlight.
 */
export function tapAck(target: HTMLElement | null | undefined): void {
  if (!target?.isConnected) return;
  target.classList.remove("tap-ack");
  void target.offsetWidth;
  target.classList.add("tap-ack");
  setTimeout(() => target.classList.remove("tap-ack"), TAP_ACK_MS);
}
