/** First-party, content-free funnel events. Never send pairing secrets or paths. */

export const PWA_EVENTS = [
  "pwa_boot",
  "pwa_pairing_start",
  "pwa_pairing_result",
  "pwa_resume",
  "pwa_live",
  "pwa_disconnect",
  "pwa_terminal",
  "pwa_agent_trace",
  "pwa_settings",
  "pwa_p2p",
  "pwa_add_computer",
  "site_copy",
] as const;

export type PwaEvent = (typeof PWA_EVENTS)[number];

const ALLOWED = new Set<string>(PWA_EVENTS);
const TOKEN_RE = /^[a-z][a-z0-9_]{0,47}$/;
const SECRET_PREFIX = /^(jg_|rt_|it_|d_|g_)/;
const MAX_BATCH = 8;

function tokenField(value: string | undefined): string | undefined {
  if (!value || !TOKEN_RE.test(value) || SECRET_PREFIX.test(value)) return undefined;
  return value;
}

export type BeaconEvent = { name: PwaEvent; result?: string; extra?: string };
export type TelemetrySender = (body: string) => void;

let queue: BeaconEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sender: TelemetrySender | null = null;

export function sanitizeBeaconEvent(name: string, fields?: { result?: string; extra?: string }): BeaconEvent | null {
  if (!ALLOWED.has(name)) return null;
  const event: BeaconEvent = { name: name as PwaEvent };
  const result = tokenField(fields?.result);
  const extra = tokenField(fields?.extra);
  if (result) event.result = result;
  if (extra) event.extra = extra;
  return event;
}

export function encodeBeaconBody(events: BeaconEvent[]): string {
  return JSON.stringify({ v: 2, events: events.slice(0, MAX_BATCH) });
}

export function setTelemetrySender(next: TelemetrySender | null): void {
  sender = next;
}

export function resetTelemetry(): void {
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function defaultSend(body: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/v2/events", blob)) return;
    }
  } catch {
    /* fall through to fetch */
  }
  if (typeof fetch !== "function") return;
  void fetch("/v2/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => undefined);
}

export function flushTelemetry(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const events = queue.splice(0, MAX_BATCH);
  const body = encodeBeaconBody(events);
  (sender ?? defaultSend)(body);
  if (queue.length) schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushTelemetry();
  }, 800);
}

export function track(name: string, fields?: { result?: string; extra?: string }): void {
  const event = sanitizeBeaconEvent(name, fields);
  if (!event) return;
  queue.push(event);
  if (queue.length >= MAX_BATCH) flushTelemetry();
  else schedule();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTelemetry();
  });
}
