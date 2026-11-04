type Bucket = { hits: number[]; windowMs: number };

const buckets = new Map<string, Bucket>();
// A key is dropped once a full window has passed since its last request. The
// sweep is lazy (driven by traffic) so a Worker isolate needs no timer.
const SWEEP_INTERVAL_MS = 60 * 1000;
// A safety valve for a flood of distinct addresses: past this many live keys,
// the least recently used one is evicted. Rate limiting stays best-effort at
// that scale instead of letting the isolate's memory grow without bound.
export const MAX_BUCKETS = 20_000;
let lastSweep = Number.NEGATIVE_INFINITY;

export const LIMITS = {
  enrollIP: { n: 10, windowMs: 60 * 60 * 1000 },
  intentIP: { n: 10, windowMs: 10 * 60 * 1000 },
  sessionIP: { n: 60, windowMs: 60 * 1000 },
  eventsIP: { n: 60, windowMs: 60 * 1000 },
} as const;

function sweep(now: number): void {
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    const last = bucket.hits[bucket.hits.length - 1];
    if (last === undefined || now - last >= bucket.windowMs) buckets.delete(key);
  }
}

export function allow(key: string, limit: number, windowMs: number, now: number): boolean {
  if (now - lastSweep >= SWEEP_INTERVAL_MS) sweep(now);
  const hits = (buckets.get(key)?.hits ?? []).filter((t) => now - t < windowMs);
  // Re-insert on every call so Map order is least-recently-used first.
  buckets.delete(key);
  if (hits.length >= limit) {
    buckets.set(key, { hits, windowMs });
    return false;
  }
  hits.push(now);
  buckets.set(key, { hits, windowMs });
  if (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined && oldest !== key) buckets.delete(oldest);
  }
  return true;
}

/** Live bucket count, for tests and diagnostics. */
export function bucketCount(): number {
  return buckets.size;
}

export function resetLimits(): void {
  buckets.clear();
  lastSweep = Number.NEGATIVE_INFINITY;
}

export function allowEnrollIP(ip: string, now: number): boolean {
  return allow(`enroll-ip:${ip}`, LIMITS.enrollIP.n, LIMITS.enrollIP.windowMs, now);
}

export function allowIntentIP(ip: string, now: number): boolean {
  return allow(`intent-ip:${ip}`, LIMITS.intentIP.n, LIMITS.intentIP.windowMs, now);
}

/**
 * Budget for `/v2/ws` upgrades that create a pending hello slot: daemons and
 * ticketless clients share one per-IP key, so neither role can spend the other's
 * allowance to fill the room's MAX_PENDING_HELLO. Ticket-bearing client upgrades
 * are bounded by single-use ticket consumption and do not count here.
 */
export function allowSessionIP(ip: string, now: number): boolean {
  return allow(`session-ip:${ip}`, LIMITS.sessionIP.n, LIMITS.sessionIP.windowMs, now);
}

export function allowEventsIP(ip: string, now: number): boolean {
  return allow(`events-ip:${ip}`, LIMITS.eventsIP.n, LIMITS.eventsIP.windowMs, now);
}
