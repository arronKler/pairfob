import { t } from "../../lib/i18n";
import type { QuotaAccountRead } from "../../lib/agent-quota-v2";
import { formatDeviceAge } from "../../lib/ui-model";
import { quotaGuidance, throttledCopy, type QuotaGuidance } from "./guidance";
import { quotaRowModel, sampleStale, type QuotaRowModel } from "./meter-model";
import { orderAccounts, providerNames, type QuotaProvider } from "./providers";

/**
 * Pure projection from a quota snapshot to the quota page: which accounts are
 * cards with numbers, which need the reader to do something, and which are
 * simply not set up on this computer.
 */

/** "1 分钟前更新"; "just now" reads as its own phrase instead of a capitalized fragment. */
export function updatedCopy(observedAt: number, now = Math.floor(Date.now() / 1000)): string {
  const when = formatDeviceAge(observedAt, now);
  return when === t("device.justNow") ? t("quota.updatedJustNow") : t("quota.updatedAgo", { when });
}

/**
 * A plan as it reads on a card. Providers send it the way their own API spells
 * it ("unified_ultra", "pro"), so a word left in lower case gets its capital;
 * a name the provider cased itself ("SuperGrok Heavy") is kept as sent.
 */
export function planName(plan: string): string | null {
  const words = plan.replaceAll("_", " ").split(" ").filter(Boolean);
  return words.map(word => word === word.toLowerCase() ? word[0]!.toUpperCase() + word.slice(1) : word).join(" ") || null;
}

/** An account with numbers to show. */
export type QuotaCardModel = {
  id: string;
  provider: QuotaProvider;
  title: string;
  /** The plan's name, or null when the provider did not say. */
  plan: string | null;
  /** When it was read and, where it tells accounts apart, which site, organization or login. */
  status: string;
  /** The read behind these numbers did not go through: the status says so in the warning colour. */
  troubled: boolean;
  tag: { text: string; tone?: "warn" } | null;
  /** The sample is too old to show its numbers; the card says so instead. */
  stale: boolean;
  /** The meters that stand for the account, or all of them when none is marked. */
  rows: QuotaRowModel[];
  /** The rest, folded under one line that still says when any of them is low. */
  more: { label: string; low: string | null; rows: QuotaRowModel[] } | null;
  notes: string[];
};

/** An account that needs the reader, or one that is not set up: no numbers, a reason and a way out. */
export type QuotaNoticeModel = { id: string; provider: QuotaProvider; title: string } & QuotaGuidance;

export type QuotaPanelModel = {
  busy: boolean;
  /** No answer has arrived yet for this session. */
  pending: boolean;
  error: string | null;
  offline: boolean;
  offlineCopy: string;
  /** The computer only answers the first quota operation. */
  legacy: boolean;
  /** Accounts of providers this build cannot show. */
  unknown: number;
  attention: QuotaNoticeModel[];
  cards: QuotaCardModel[];
  /** When the newest card was read. */
  updated: string | null;
  others: QuotaNoticeModel[];
};

/** The slice of a published snapshot the projections read. */
export type QuotaSnapshotLike = {
  readonly loading: boolean;
  readonly items: readonly QuotaAccountRead[] | null;
  readonly error: string;
  readonly legacy?: boolean;
  readonly unknown?: number;
};

function accountTitle(account: Pick<QuotaAccountRead, "provider">): string {
  return providerNames[account.provider];
}

/** A notice has no second line to say which account it is, so its title does. */
function noticeTitle(account: QuotaAccountRead): string {
  return [accountTitle(account), ...originCopy(account)].join(" · ");
}

/** What tells this account from another of the same provider; empty for the usual single personal one. */
export function originCopy(account: Pick<QuotaAccountRead, "region" | "scope" | "label">): string[] {
  const parts: string[] = [];
  if (account.region) parts.push(account.region === "cn" ? t("quota.region.cn") : account.region === "global" ? t("quota.region.global") : account.region.toUpperCase());
  if (account.scope === "org") parts.push(t("quota.scope.org"));
  if (account.label) parts.push(account.label);
  return parts;
}

/** Whether an account has numbers worth a card: read now, or kept from a read a few minutes ago. */
export function hasNumbers(account: QuotaAccountRead, now: number): boolean {
  if (account.state === "ok" || account.state === "partial") return true;
  return (account.state === "failed" || account.state === "throttled") && account.meters.length > 0 && !sampleStale(account, now);
}

export function quotaCardModel(account: QuotaAccountRead, now = Date.now() / 1000): QuotaCardModel {
  const title = accountTitle(account);
  const stale = sampleStale(account, now);
  const kept = account.state === "failed" || account.state === "throttled";
  const when = kept
    ? account.state === "throttled"
      ? throttledCopy(account.retry_at, now)
      : `${t("quota.sampleFrom", { when: formatDeviceAge(account.observed_at, Math.floor(now)) })} · ${t(account.reason === "timeout" ? "quota.reason.timeout" : "quota.reason.unread")}`
    : updatedCopy(account.observed_at, Math.floor(now));
  const rows = account.meters.map((meter, index) => ({ meter, row: quotaRowModel(title, meter, index, now) }));
  // With no meter marked, none can be set aside: all of them are the account.
  const marked = rows.some(({ meter }) => meter.headline);
  const main = rows.filter(({ meter }) => !marked || meter.headline || meter.kind === "unread").map(({ row }) => row);
  const rest = rows.filter(({ meter }) => marked && !meter.headline && meter.kind !== "unread").map(({ row }) => row);
  const low = rest.filter(row => row.low).length;
  const notes: string[] = [];
  if (account.provider === "copilot") notes.push(t("quota.copilotNote"));
  if (account.provider === "grok") notes.push(t("quota.grokNote"));
  if (account.provider === "deepseek") notes.push(t("quota.deepseekNote"));
  if (account.provider === "opencode-go") notes.push(t("quota.opencodeGoNote"));
  if (account.provider === "command-code") notes.push(t("quota.commandCodeNote"));
  if (account.source === "statusline") notes.push(t("quota.claudeNote"));
  return {
    id: account.id,
    provider: account.provider,
    title,
    plan: planName(account.plan),
    status: [...originCopy(account), when].join(" · "),
    troubled: kept,
    tag: stale ? { text: t("quota.staleTag"), tone: "warn" }
      : account.state === "partial" ? { text: t("quota.tag.partial") }
      : account.state === "throttled" ? { text: t("quota.tag.later"), tone: "warn" }
      : null,
    stale,
    rows: stale ? [] : main,
    more: stale || !rest.length ? null : {
      label: t("quota.more", { n: rest.length }),
      low: low ? t("quota.moreLow", { n: low }) : null,
      rows: rest,
    },
    notes,
  };
}

function noticeModel(account: QuotaAccountRead, legacy: boolean, now: number): QuotaNoticeModel {
  return { id: account.id, provider: account.provider, title: noticeTitle(account), ...quotaGuidance(account, !legacy, now) };
}

/**
 * The page in three groups, each in the reader's own order: what needs them,
 * what has numbers, and what this computer has no login for. A login that is
 * there but cannot be read needs them; no trace of one does not.
 */
export function quotaPanelModel(snapshot: QuotaSnapshotLike | undefined, connected: boolean, order: readonly QuotaProvider[] = [], now = Date.now() / 1000): QuotaPanelModel {
  const legacy = snapshot?.legacy === true;
  const accounts = orderAccounts(snapshot?.items ?? [], order);
  const carded = accounts.filter(account => hasNumbers(account, now));
  const newest = carded.reduce((latest, account) => Math.max(latest, account.observed_at), 0);
  return {
    busy: !!snapshot?.loading,
    pending: !snapshot?.items,
    error: snapshot?.error === "quota.upgrade" || snapshot?.error === "quota.failed"
      ? t(snapshot.items && snapshot.error === "quota.failed" ? "quota.kept" : snapshot.error) : snapshot?.error || null,
    offline: !connected,
    offlineCopy: t("quota.offline"),
    legacy,
    unknown: snapshot?.unknown ?? 0,
    attention: accounts.filter(account => account.state !== "not_configured" && !hasNumbers(account, now)).map(account => noticeModel(account, legacy, now)),
    cards: carded.map(account => quotaCardModel(account, now)),
    updated: newest ? updatedCopy(newest, Math.floor(now)) : null,
    others: accounts.filter(account => account.state === "not_configured").map(account => noticeModel(account, legacy, now)),
  };
}
