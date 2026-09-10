import { node, prefersReducedMotion } from "../../../lib/dom";

/**
 * On a phone the keypad and the terminal are two separate regions, so pressing
 * Esc or Ctrl+C produces no visible change and cannot be told apart from "the
 * key did nothing". A spark travelling from the keycap to the caret draws that
 * missing causal link.
 */

const FLIGHT_MS = 340;
const PULSE_MS = 160;
const LABEL_MS = 600;
/** Auto-repeat fires every 90ms; one spark per repeat would be a swarm. */
const THROTTLE_MS = 200;

let lastFlight = 0;

/** Keys that print nothing, so the terminal alone can never confirm them. */
const SILENT = new Set(["esc", "tab", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "delete", "backspace"]);

function isSilent(key: string): boolean {
  return key.startsWith("ctrl+") || SILENT.has(key);
}

/** Human-facing name for a token the terminal will not echo. */
function keyLabel(key: string): string {
  if (key.startsWith("ctrl+")) return `Ctrl+${key.slice(5).toUpperCase()}`;
  return key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
}

/**
 * The layer sits outside the scroller: a spark parked inside `.term` would
 * travel again with the next scroll.
 */
function overlay(term: HTMLElement): HTMLElement {
  const host = term.closest(".term-wrap") ?? term;
  const mounted = host.querySelector(".key-flight-layer");
  if (mounted instanceof HTMLElement) return mounted;
  const layer = node("div", "key-flight-layer");
  layer.setAttribute("aria-hidden", "true");
  host.append(layer);
  return layer;
}

/**
 * Where the caret is, in viewport coordinates. Snapshots carry no cursor, so
 * the end of the last written row is the closest honest answer; an empty
 * screen falls back to where a first line would start.
 */
function caretPoint(term: HTMLElement): { x: number; y: number } | null {
  const rows = [...term.querySelectorAll<HTMLElement>(".term-line")];
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at];
    if (!row.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(row);
    range.collapse(false);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) return { x: rect.right, y: rect.top + rect.height / 2 };
    const rowRect = row.getBoundingClientRect();
    return { x: rowRect.left, y: rowRect.top + rowRect.height / 2 };
  }
  const rect = term.getBoundingClientRect();
  return rect.width ? { x: rect.left + 8, y: rect.top + 12 } : null;
}

/** A brief brightening at the caret: the arrival half of the causal link. */
function pulseCaret(layer: HTMLElement, base: DOMRect, at: { x: number; y: number }): void {
  const pulse = node("span", "key-caret-pulse");
  pulse.style.left = `${at.x - base.left}px`;
  pulse.style.top = `${at.y - base.top}px`;
  layer.append(pulse);
  window.setTimeout(() => pulse.remove(), PULSE_MS + 40);
}

function showLabel(layer: HTMLElement, key: string): void {
  const tag = node("span", "key-flight-label", keyLabel(key));
  layer.append(tag);
  window.setTimeout(() => tag.remove(), LABEL_MS);
}

/**
 * Send a spark from `keyEl` to the caret in `term`. Reduced motion keeps the
 * caret pulse and the label, which carry the information, and drops the travel.
 */
export function flyKeyToCursor(
  keyEl: HTMLElement | null | undefined,
  term: HTMLElement | null,
  key: string,
  at?: { x: number; y: number } | null,
): void {
  if (!term) return;
  const now = typeof performance === "undefined" ? Date.now() : performance.now();
  if (now - lastFlight < THROTTLE_MS) return;
  lastFlight = now;

  const target = at ?? caretPoint(term);
  if (!target) return;
  const layer = overlay(term);
  const base = layer.getBoundingClientRect();
  const silent = isSilent(key);
  pulseCaret(layer, base, target);
  if (silent) showLabel(layer, key);

  const from = keyEl?.getBoundingClientRect();
  if (!from || !from.width || prefersReducedMotion()) return;
  const spark = node("span", silent ? "key-spark is-silent" : "key-spark");
  if (typeof spark.animate !== "function") return;
  spark.style.left = `${from.left + from.width / 2 - base.left}px`;
  spark.style.top = `${from.top + from.height / 2 - base.top}px`;
  layer.append(spark);
  const travel = spark.animate(
    [
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      {
        transform: `translate(calc(-50% + ${Math.round(target.x - from.left - from.width / 2)}px), calc(-50% + ${Math.round(target.y - from.top - from.height / 2)}px)) scale(0.4)`,
        opacity: 0,
      },
    ],
    { duration: FLIGHT_MS, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "forwards" },
  );
  const done = () => spark.remove();
  travel.addEventListener("finish", done);
  travel.addEventListener("cancel", done);
}
