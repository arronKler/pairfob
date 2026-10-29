import { locale, t, type CopyKey } from "../../lib/i18n";
import type { QuotaAccountRead, QuotaLevel, QuotaMeter, QuotaUnit } from "../../lib/agent-quota-v2";

/**
 * Pure projection from one quota meter to what a row paints: its label, its
 * second line and the figure on the trailing edge. No application state and no
 * DOM; every function takes the data it reads.
 */

/** A sample older than this is not shown as current. */
const SAMPLE_MAX_AGE = 900;

const NAMES: Record<string, CopyKey> = {
  "premium interactions": "quota.window.premium",
  chat: "quota.window.chat",
  completions: "quota.window.completions",
  "shared subscription quota": "quota.window.shared",
  "included plan": "quota.window.included",
  "five hour": "quota.window.fiveHour",
  "seven day": "quota.window.sevenDay",
  monthly: "quota.window.monthly",
  "monthly balance": "quota.name.monthlyBalance",
  "seven day sonnet": "quota.window.sevenDaySonnet",
  "seven day opus": "quota.window.sevenDayOpus",
  "seven day cowork": "quota.window.sevenDayCowork",
  "seven day routines": "quota.window.sevenDayRoutines",
  "spend limit": "quota.window.spend",
  "top up": "quota.name.topUp",
  balance: "quota.name.balance",
  "monthly credits": "quota.name.monthlyCredits",
  "premium requests": "quota.name.premiumRequests",
  "model quota": "quota.name.modelQuota",
};

export function quotaWindowName(name: string): string {
  const key = NAMES[name.replaceAll("_", " ").toLowerCase()];
  return key ? t(key) : name;
}

/** Whether the whole sample is too old (or dated ahead of this clock) to show as current. */
export function sampleStale(account: Pick<QuotaAccountRead, "observed_at">, now = Date.now() / 1000): boolean {
  return now - account.observed_at >= SAMPLE_MAX_AGE || account.observed_at > now + 60;
}

/** A meter whose reset has passed says nothing about the new period: it needs a new sample. */
export function meterExpired(meter: QuotaMeter, now = Date.now() / 1000): boolean {
  return meter.resets_at > 0 && meter.resets_at <= now;
}

export type QuotaTone = "ok" | "warn" | "error";

/** Below 30% the meter turns yellow, below 10% red. */
export function quotaTone(remaining: number): QuotaTone {
  return remaining < 10 ? "error" : remaining < 30 ? "warn" : "ok";
}

/** When a window comes back, relative to now: "2 小时后重置". */
export function quotaResetIn(resetsAt: number, now = Date.now() / 1000): string {
  if (!resetsAt) return t("quota.resetUnknown");
  const seconds = resetsAt - now;
  if (seconds < 60) return t("quota.resetSoon");
  if (seconds < 3_600) return t("quota.resetIn.minutes", { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("quota.resetIn.hours", { n: Math.floor(seconds / 3_600) });
  return t("quota.resetIn.days", { n: Math.floor(seconds / 86_400) });
}

/** The reset point itself: a clock time within a day, a short date after that. */
export function quotaResetAt(resetsAt: number, now = Date.now() / 1000): string {
  const at = new Date(resetsAt * 1000);
  return resetsAt - now < 86_400
    ? new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(at)
    : new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(at);
}

/** A span as a short label ("5 小时", "7 天"), or "" when the provider gave none. */
function spanLabel(minutes: number): string {
  if (!minutes) return "";
  if (minutes % 1440 === 0) return t("quota.span.days", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("quota.span.hours", { count: minutes / 60 });
  return t("quota.span.minutes", { count: minutes });
}

/**
 * What a meter is called. A plan's own window is its span ("5 小时"); anything
 * else needs its name, because a span alone would not say which model or
 * category the window meters.
 */
export function meterLabel(meter: QuotaMeter): string {
  const span = spanLabel(meter.window_minutes);
  if (span && meter.headline && (meter.kind === "quota" || meter.kind === "level")) return span;
  const name = quotaWindowName(meter.name);
  return name !== meter.name || !span ? name : `${name} · ${span}`;
}

const UNIT_KEYS = {
  usd: "quota.unit.usd", cny: "quota.unit.cny", credits: "quota.unit.credits", requests: "quota.unit.requests", hours: "quota.unit.hours",
} as const satisfies Record<QuotaUnit, CopyKey>;

function numberText(amount: number, scale: number): string {
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: scale, maximumFractionDigits: scale }).format(amount / 10 ** scale);
}

/** An integer amount with its decimal places and unit: "$12.40", "1,280 credits". */
export function amountText(amount: number, scale: number, unit: QuotaUnit): string {
  return t(UNIT_KEYS[unit], { n: numberText(amount, scale) });
}

const LEVELS = {
  full: { pips: 5, rank: 100, tone: "ok", copy: "quota.level.full" },
  high: { pips: 4, rank: 75, tone: "ok", copy: "quota.level.high" },
  medium: { pips: 3, rank: 50, tone: "ok", copy: "quota.level.medium" },
  low: { pips: 1, rank: 20, tone: "warn", copy: "quota.level.low" },
  empty: { pips: 0, rank: 0, tone: "error", copy: "quota.level.empty" },
} as const satisfies Record<QuotaLevel, { pips: number; rank: number; tone: QuotaTone; copy: CopyKey }>;

/**
 * What a meter paints on the trailing edge. A share is a bar and a number; a
 * level is five pips and a word, so it never reads as a percentage; a balance
 * is a figure with no bar, because it has no ceiling to be a share of; and a
 * meter with nothing current to say (`pending`) is a quiet word.
 */
export type QuotaMeterModel = (
  | { kind: "limited"; remaining: number; tone: QuotaTone }
  | { kind: "unlimited" }
  | { kind: "level"; pips: number; word: string; tone: QuotaTone }
  | { kind: "balance"; text: string }
  | { kind: "pending"; text: string }
) & {
  aria: string;
  /** The exact reset and the counts behind a share, for a pointer that rests on the meter. The row's own text already says them in short. */
  hint?: string;
};

/** The reset as a full date and time, and what was used of how much. */
function meterHint(meter: QuotaMeter): string | undefined {
  const parts: string[] = [];
  if (meter.kind === "quota" && meter.count) {
    const { used, limit, scale, unit } = meter.count;
    parts.push(t("quota.hint.used", { used: numberText(used, scale), total: amountText(limit, scale, unit) }));
  }
  if (meter.resets_at) {
    const when = new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(meter.resets_at * 1000));
    parts.push(t("quota.hint.reset", { when }));
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export function meterModel(title: string, meter: QuotaMeter, now = Date.now() / 1000): QuotaMeterModel {
  // A reset that has passed is not a time to promise.
  const hint = meterExpired(meter, now) ? undefined : meterHint(meter);
  const painted = paintModel(title, meter, now);
  return hint ? { ...painted, hint } : painted;
}

function paintModel(title: string, meter: QuotaMeter, now: number): QuotaMeterModel {
  const label = meterLabel(meter);
  const said = (value: string): string => t("quota.valueAria", { name: title, window: label, value });
  if (meter.kind === "unread") return { kind: "pending", text: "—", aria: said(t("quota.reason.unread")) };
  if (meterExpired(meter, now)) return { kind: "pending", text: t("quota.pending"), aria: said(t("quota.expired")) };
  switch (meter.kind) {
    case "unlimited":
      return { kind: "unlimited", aria: said(t("quota.unlimited")) };
    case "level": {
      const level = LEVELS[meter.level];
      return { kind: "level", pips: level.pips, word: t(level.copy), tone: level.tone, aria: said(t(level.copy)) };
    }
    case "balance": {
      const text = amountText(meter.amount, meter.scale, meter.unit);
      return { kind: "balance", text, aria: said(text) };
    }
    default: {
      const remaining = Math.round(100 - meter.used_percent);
      return { kind: "limited", remaining, tone: quotaTone(remaining), aria: t("quota.meterAria", { name: title, window: label, percent: remaining }) };
    }
  }
}

/** Whether a meter is running low: under 30% of a share, or a level the provider calls low. */
export function meterLow(meter: QuotaMeter, now = Date.now() / 1000): boolean {
  if (meterExpired(meter, now)) return false;
  if (meter.kind === "quota") return 100 - meter.used_percent < 30;
  return meter.kind === "level" && LEVELS[meter.level].rank < 30;
}

/** One meter row: its label, its second line and its figure. */
export type QuotaRowModel = { key: string; label: string; sub: string; meter: QuotaMeterModel; low: boolean; quiet: boolean };

function rowSub(meter: QuotaMeter, now: number, full: boolean): string {
  if (meter.kind === "unread") return t("quota.reason.unread");
  if (meterExpired(meter, now)) return t("quota.expired");
  const reset = meter.resets_at ? (full ? `${quotaResetIn(meter.resets_at, now)} · ${quotaResetAt(meter.resets_at, now)}` : quotaResetIn(meter.resets_at, now)) : "";
  switch (meter.kind) {
    case "unlimited":
      return t("quota.unlimited");
    case "balance":
      return reset || t("quota.noReset");
    case "level":
      return reset || t("quota.levelOnly");
    default: {
      if (!meter.count) return reset || t("quota.resetUnknown");
      const { used, limit, scale, unit } = meter.count;
      const count = t("quota.count", { left: numberText(Math.max(0, limit - used), scale), total: amountText(limit, scale, unit) });
      // Beside the counts the reset keeps to its short form, so the line stays one line.
      return meter.resets_at ? `${count} · ${quotaResetIn(meter.resets_at, now)}` : count;
    }
  }
}

export function quotaRowModel(title: string, meter: QuotaMeter, index: number, now = Date.now() / 1000): QuotaRowModel {
  return {
    key: `${meter.pool}:${meter.name}:${index}`,
    label: meterLabel(meter),
    sub: rowSub(meter, now, true),
    meter: meterModel(title, meter, now),
    low: meterLow(meter, now),
    quiet: meter.kind === "unread" || meterExpired(meter, now),
  };
}

/** A meter's second line where its label shares the line: "7 天 · 4 天后重置". */
export function meterSummarySub(meter: QuotaMeter, now = Date.now() / 1000): string {
  const label = meterLabel(meter);
  if (meter.kind === "quota" && !meter.resets_at) return `${label} · ${t("quota.resetUnknown")}`;
  if (meter.kind === "balance" || meter.kind === "level") return meter.resets_at ? `${label} · ${quotaResetIn(meter.resets_at, now)}` : label;
  return `${label} · ${meter.kind === "unlimited" ? t("quota.unlimited") : quotaResetIn(meter.resets_at, now)}`;
}

/** How tight a meter is, for choosing among an account's headline meters only. */
function tightness(meter: QuotaMeter): number | null {
  if (meter.kind === "quota") return 100 - meter.used_percent;
  if (meter.kind === "level") return LEVELS[meter.level].rank;
  return null;
}

/**
 * The one meter that stands for an account: among those the computer marked,
 * the tightest share or level, else an unlimited one, else a balance. An
 * account with no marks is summed up only by a meter that is its only one.
 * Null when there is nothing current to show: no sample, an old one, or only
 * meters past their reset.
 */
export function summaryMeter(account: Pick<QuotaAccountRead, "meters" | "observed_at">, now = Date.now() / 1000): QuotaMeter | null {
  if (!account.meters.length || sampleStale(account, now)) return null;
  const marked = account.meters.filter(meter => meter.headline);
  const pool = marked.length ? marked : account.meters.length === 1 ? account.meters : [];
  const current = pool.filter(meter => meter.kind !== "unread" && !meterExpired(meter, now));
  let tightest: QuotaMeter | null = null;
  for (const meter of current) {
    const value = tightness(meter);
    if (value !== null && (tightest === null || value < (tightness(tightest) as number))) tightest = meter;
  }
  return tightest ?? current.find(meter => meter.kind === "unlimited") ?? current.find(meter => meter.kind === "balance") ?? null;
}
