import { currentDaemonId, liveSession } from "../computers/catalog-store";
import { goToScreen } from "../../app/navigation-store";
import { ProtocolError } from "../../lib/protocol/errors";
import { commitView } from "../../app/host";
import { loadQuotaCache, saveQuotaCache } from "../../lib/quota-cache";
import type { LiveSession } from "../../lib/protocol/session-types";
import { quotaSnapshot, setQuotaSnapshot, type QuotaSnapshot } from "./store";

/**
 * Quota controller — the feature's one connected adapter.
 *
 * It reads the computers domain for the established session and navigates
 * through the navigation action.
 *
 * Data updates deliberately do NOT repaint the app: the snapshot store notifies
 * its own subscribers, so a mounted quota page or settings summary refreshes on
 * its own — and a refresh that finishes after a computer switch notifies nobody
 * who is looking at it, because the answer landed on the retired session.
 *
 * Navigation commits through the application port (`commitView`): the installed
 * App composes the arriving screen synchronously. With no host installed the
 * controller is headless and mounts nothing.
 */

/** In-flight read guard: one outstanding quota request per session. */
function alreadyLoading(): boolean {
  const session = liveSession();
  return !!session && quotaSnapshot(session)?.loading === true;
}

/**
 * What this session already shows, else the last answer saved for this
 * computer. A page opened after a reload paints those balances immediately
 * while the read below runs; the sample times inside the answer still decide
 * how old they are.
 */
function previousSnapshot(session: LiveSession, daemon: string | null): QuotaSnapshot | undefined {
  const live = quotaSnapshot(session);
  if (live) return live;
  const saved = daemon ? loadQuotaCache(daemon) : null;
  return saved ? { loading: false, items: saved.items, legacy: saved.legacy, unknown: saved.unknown, error: "" } : undefined;
}

/**
 * How a refresh ended, for the control that asked: `unchanged` is an answer
 * that says what the page already shows (the computer keeps a read for a
 * minute), which would otherwise look like a press that did nothing.
 */
export type QuotaRefresh = "skipped" | "updated" | "unchanged" | "failed";

const completed = new WeakMap<LiveSession, number>();

export async function refreshAgentQuota(reuseRecent = false): Promise<QuotaRefresh> {
  const session = liveSession();
  if (!session || !session.isConnected() || alreadyLoading()) return "skipped";
  // The computer this read belongs to, captured with the session: a switch
  // while it is in flight must not file its answer under the next computer.
  const daemon = currentDaemonId();
  const previous = previousSnapshot(session, daemon);
  // Coalesce a quick settings → quota navigation, never an explicit refresh.
  // Do not extend the daemon's one-minute sample freshness window.
  if (reuseRecent && previous && !previous.error && performance.now() - (completed.get(session) ?? -Infinity) < 5_000
    && previous.items?.every(account => !account.observed_at || Date.now() / 1_000 - account.observed_at < 60)) return "skipped";
  let kept = { items: previous?.items ?? null, legacy: previous?.legacy, unknown: previous?.unknown };
  let active = true;
  setQuotaSnapshot(session, { loading: true, ...kept, error: "" });
  try {
    const report = await session.agentQuota(part => {
      if (!active) return;
      const arrived = new Map(part.accounts.map(account => [account.id, account]));
      // Keep cached accounts until their own result arrives. The final report
      // is authoritative, including accounts removed from this computer.
      const items = (previous?.items ?? []).map(account => arrived.get(account.id) ?? account);
      const retained = new Set(items.map(account => account.id));
      items.push(...part.accounts.filter(account => !retained.has(account.id)));
      kept = { items, legacy: part.legacy, unknown: part.unknown };
      setQuotaSnapshot(session, { loading: true, ...kept, error: "" });
    });
    completed.set(session, performance.now());
    const unchanged = !!previous?.items && !previous.error && sameSample(previous.items, report.accounts);
    setQuotaSnapshot(session, { loading: false, items: report.accounts, legacy: report.legacy, unknown: report.unknown, error: "" });
    if (daemon && liveSession() === session) {
      saveQuotaCache(daemon, { items: report.accounts, legacy: report.legacy, unknown: report.unknown });
    }
    return unchanged ? "unchanged" : "updated";
  } catch (error) {
    // What was read before stays on the page under the error: a failed read
    // says nothing about the accounts, and each card shows how old it is.
    const upgrade = error instanceof ProtocolError && error.code === "unknown_op";
    setQuotaSnapshot(session, upgrade ? { loading: false, items: null, error: "quota.upgrade" } : { loading: false, ...kept, error: "quota.failed" });
    return "failed";
  } finally {
    active = false;
  }
}

type Sampled = { readonly id: string; readonly state: string; readonly reason: string; readonly observed_at: number };

/** Whether two answers are the same reads: the same accounts, in the same state, sampled at the same time. */
function sameSample(left: readonly Sampled[], right: readonly Sampled[]): boolean {
  return left.length === right.length && left.every((account, index) => {
    const other = right[index];
    return other.id === account.id && other.state === account.state && other.reason === account.reason && other.observed_at === account.observed_at;
  });
}

/**
 * Navigation, so it repaints through the application port: the quota page has
 * to be composed first. Opening from one account's row lands on its card.
 */
export function openQuota(id?: string): void {
  goToScreen("quota");
  commitView();
  void refreshAgentQuota(true);
  if (id) focusQuotaCard(id);
}

function focusQuotaCard(id: string): void {
  const card = document.getElementById(`quota-${id}`);
  if (!card) return;
  card.scrollIntoView({ block: "start" });
  card.classList.add("is-focused");
  globalThis.setTimeout(() => card.classList.remove("is-focused"), 1_600);
}
