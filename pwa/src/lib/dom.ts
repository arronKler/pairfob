export { askConfirm, askText, showHelp, type HelpBlock } from "./basic-dialogs";

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const RIPPLE_MS = 520;

/** Selectors whose geometry motion.css prepares as a ripple host. */
export const RIPPLE_ACTIONS = ".btn-primary, .btn-scan, .send-btn, .card-main, .menu-item";

function spawnRipple(host: HTMLElement, clientX: number, clientY: number): void {
  if (prefersReducedMotion() || host.matches(":disabled, [aria-disabled='true']")) return;
  const box = host.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const x = clientX - box.left;
  const y = clientY - box.top;
  const ink = node("span", "ripple");
  ink.style.left = `${x}px`;
  ink.style.top = `${y}px`;
  const reach = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
  ink.style.width = `${reach * 2}px`;
  ink.style.height = `${reach * 2}px`;
  host.append(ink);
  setTimeout(() => ink.remove(), RIPPLE_MS);
}

/** One document listener covers React controls and dialogs across route changes. */
export function bindRippleSurface(root: Document | HTMLElement, selector = RIPPLE_ACTIONS): void {
  root.addEventListener("pointerdown", (event) => {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    const host = (event.target as Element | null)?.closest?.(selector);
    if (host instanceof HTMLElement) spawnRipple(host, event.clientX, event.clientY);
  });
}

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

const TAP_ACK_MS = 120;

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
