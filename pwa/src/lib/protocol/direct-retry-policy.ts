export const DIRECT_RETRY_STEPS_MS = [30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
export const DIRECT_RETRY_MAX_MS = DIRECT_RETRY_STEPS_MS[DIRECT_RETRY_STEPS_MS.length - 1];

/** Back off failed direct upgrades while jittering repeated probes across clients. */
export function directRetryDelay(attempt: number, random = Math.random): number {
  const index = Math.min(Math.max(0, attempt), DIRECT_RETRY_STEPS_MS.length - 1);
  const base = DIRECT_RETRY_STEPS_MS[index];
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(DIRECT_RETRY_MAX_MS, Math.round(base * jitter));
}
