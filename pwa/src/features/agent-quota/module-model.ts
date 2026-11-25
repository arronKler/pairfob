import { t } from "../../lib/i18n";
import { hasNumbers, originCopy, updatedCopy, type QuotaSnapshotLike } from "./card-model";
import { meterLow, meterModel, meterSummarySub, summaryMeter, type QuotaMeterModel } from "./meter-model";
import { orderAccounts, shortProviderNames, type QuotaProvider } from "./providers";

/**
 * The settings quota module: a few accounts at a glance and the way into the
 * full page. Pure, like the page's own projection.
 */

/** The module never grows past this many accounts, however many the computer reads. */
export const MODULE_ROWS = 4;

/** One account row in the settings quota module. */
export type QuotaModuleRow = { id: string; provider: QuotaProvider; name: string; sub: string; meter: QuotaMeterModel };

export type QuotaModuleModel = {
  /** Offline and failed reads show one line instead of empty meters. */
  state: "offline" | "loading" | "error" | "ready";
  rows: QuotaModuleRow[];
  /** Accounts with numbers on the full page, shown here or not. */
  total: number;
  /** Accounts whose login is there but cannot be read. */
  attention: number;
  updated: string | null;
  /** The displayed accounts are not a successfully completed current batch. */
  incomplete?: boolean;
};

/**
 * At most four accounts. An account running low takes a place before one that
 * is not; the places left go to the reader's most-used agents. What is left
 * only decides who is shown: the rows themselves stay in the reader's order, so
 * a changing number never moves one.
 */
export function quotaModuleModel(snapshot: QuotaSnapshotLike | undefined, connected: boolean, order: readonly QuotaProvider[] = [], now = Date.now() / 1000): QuotaModuleModel {
  const blank = { rows: [], total: 0, attention: 0, updated: null };
  if (!connected) return { state: "offline", ...blank };
  if (!snapshot?.items) return { state: snapshot?.loading ? "loading" : "error", ...blank };
  const accounts = orderAccounts(snapshot.items, order);
  const summed = accounts.flatMap(account => {
    const meter = summaryMeter(account, now);
    return meter ? [{ account, meter, low: meterLow(meter, now) }] : [];
  });
  const shown = new Set([...summed.filter(entry => entry.low), ...summed.filter(entry => !entry.low)].slice(0, MODULE_ROWS));
  const rows = summed.filter(entry => shown.has(entry)).map(({ account, meter }): QuotaModuleRow => {
    // A second account of a provider is told from the first by its site, organization or login.
    const name = [shortProviderNames[account.provider], ...originCopy(account)].join(" · ");
    return { id: account.id, provider: account.provider, name, sub: meterSummarySub(meter, now), meter: meterModel(name, meter, now) };
  });
  const cards = accounts.filter(account => hasNumbers(account, now));
  const newest = cards.reduce((latest, account) => Math.max(latest, account.observed_at), 0);
  return {
    state: "ready",
    ...(snapshot.loading || snapshot.error ? { incomplete: true } : {}),
    rows,
    total: cards.length,
    attention: accounts.filter(account => account.state !== "not_configured" && !hasNumbers(account, now)).length,
    updated: snapshot.error ? t("quota.failed") : snapshot.loading ? t("quota.readingMore") : newest ? updatedCopy(newest, Math.floor(now)) : null,
  };
}
