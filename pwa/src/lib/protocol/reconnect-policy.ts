export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/** Bounded jitter prevents every suspended phone from reconnecting together. */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 5));
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(RECONNECT_MAX_MS, Math.round(base * jitter));
}
