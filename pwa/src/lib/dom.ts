/**
 * Legacy DOM helper entry.
 *
 * The generic pieces moved to `shared/ui`: press feedback and motion preference
 * live in `shared/ui/dom`, and the promise dialogs live in
 * `shared/ui/overlay/basic-dialogs`. Both are re-exported here so existing
 * callers keep compiling during the staged migration. What remains is the
 * element factory and the app-wide ripple surface.
 */
export { askConfirm, askText, showHelp, type HelpBlock } from "../shared/ui/overlay/basic-dialogs";
export { haptic, tapAck } from "../shared/ui/dom/feedback";
export { prefersReducedMotion } from "../shared/ui/dom/motion";

import { prefersReducedMotion } from "../shared/ui/dom/motion";

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
export function bindRippleSurface(root: Document | HTMLElement, selector = RIPPLE_ACTIONS): () => void {
  const onPointerDown = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    const host = (event.target as Element | null)?.closest?.(selector);
    if (host instanceof HTMLElement) spawnRipple(host, event.clientX, event.clientY);
  };
  root.addEventListener("pointerdown", onPointerDown);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
  };
}
