import { parseQuotaAccounts, quotaAccountToWire, type QuotaAccountRead } from "./agent-quota-v2";

/**
 * The last quota answer this browser read from one computer, kept so the page
 * can show balances on the first paint instead of waiting for the computer to
 * ask every provider again. The answer is written in the wire shape and read
 * back through the same strict decoder, so a stale or edited record is dropped
 * rather than trusted. The sample times inside it say how old it is; the page
 * already hides numbers older than fifteen minutes.
 */

export type QuotaCache = {
  items: QuotaAccountRead[];
  legacy: boolean;
  unknown: number;
};

const PREFIX = "pairfob.quota.v1.";
const MAX_LENGTH = 256 * 1024;
const MAX_ITEMS = 64;
const DAEMON_ID = /^[A-Za-z0-9_-]{1,128}$/;

function keyFor(daemonId: string): string | null {
  return DAEMON_ID.test(daemonId) ? PREFIX + daemonId : null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved answer for one computer, or null when there is none or it no longer fits the schema. */
export function loadQuotaCache(daemonId: string): QuotaCache | null {
  const key = keyFor(daemonId);
  const store = storage();
  if (!key || !store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw || raw.length > MAX_LENGTH) return null;
    const saved = JSON.parse(raw) as { v?: unknown; items?: unknown; legacy?: unknown; unknown?: unknown } | null;
    if (!saved || saved.v !== 1 || !Array.isArray(saved.items) || saved.items.length > MAX_ITEMS) return null;
    const parsed = parseQuotaAccounts({ items: saved.items });
    const extra = typeof saved.unknown === "number" && Number.isSafeInteger(saved.unknown) && saved.unknown >= 0 ? saved.unknown : 0;
    return {
      items: parsed.accounts,
      legacy: saved.legacy === true,
      unknown: Math.min(extra + parsed.unknown, MAX_ITEMS),
    };
  } catch {
    return null;
  }
}

/** Keep one answer for the next app start. Storage that is full or unavailable is not an error. */
export function saveQuotaCache(daemonId: string, cache: QuotaCache): void {
  const key = keyFor(daemonId);
  const store = storage();
  if (!key || !store) return;
  try {
    const raw = JSON.stringify({
      v: 1,
      items: cache.items.slice(0, MAX_ITEMS).map(quotaAccountToWire),
      legacy: cache.legacy,
      unknown: cache.unknown,
    });
    if (raw.length <= MAX_LENGTH) store.setItem(key, raw);
  } catch {
    // The live answer still reaches the page; only the next start loses it.
  }
}

/** Drop one computer's saved answer, as when it is forgotten. */
export function clearQuotaCache(daemonId: string): void {
  const key = keyFor(daemonId);
  const store = storage();
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do: the record is unreadable to a page without this computer.
  }
}

/** Tests: drop every computer's saved answer so one case cannot seed the next. */
export function resetQuotaCache(): void {
  const store = storage();
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const name = store.key(index);
      if (name?.startsWith(PREFIX)) store.removeItem(name);
    }
  } catch {
    // Storage unavailable: there is nothing saved to reset.
  }
}
