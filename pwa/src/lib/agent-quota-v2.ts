import { ProtocolError } from "./protocol/errors";

/**
 * The AgentQuotaV2 result (`proto/agent-quota.md`): one item per subscription
 * account, each with meters of several kinds.
 *
 * The decoded shape is normalized: an optional wire field that was left out
 * reads as zero or the empty string, so a reader never tests for absence.
 */

/** The providers this build can name and explain. An item of any other is dropped, not refused. */
export const QUOTA_PROVIDERS = ["codex", "claude", "antigravity", "copilot", "cursor", "grok", "deepseek", "opencode-go", "command-code"] as const;
export type QuotaProvider = typeof QUOTA_PROVIDERS[number];

export type QuotaState = "ok" | "partial" | "failed" | "throttled" | "needs_action" | "not_configured";
/**
 * Why an account has no fresh numbers. `sign_in` never comes off the wire: it
 * is what an older computer's "sign in or authorize" means, which cannot tell
 * an expired login from one that was never there.
 */
export type QuotaReason = "" | "unavailable" | "timeout" | "relogin" | "allow_keychain" | "choose_account" | "setup"
  | "no_login" | "not_installed" | "not_running" | "unsupported_login" | "sign_in";
export type QuotaUnit = "usd" | "cny" | "credits" | "requests" | "hours";
export type QuotaLevel = "full" | "high" | "medium" | "low" | "empty";

type MeterBase = {
  name: string;
  /** Meters of one pool limit the same usage; different pools are never compared. */
  pool: string;
  /** The meters that stand for the account in a summary. */
  headline: boolean;
  /** Zero when the provider gave no span. */
  window_minutes: number;
  /** Unix seconds; zero when the provider gave no reset. */
  resets_at: number;
};
export type QuotaMeter =
  | MeterBase & { kind: "quota"; used_percent: number; count: { used: number; limit: number; scale: number; unit: QuotaUnit } | null }
  | MeterBase & { kind: "balance"; amount: number; scale: number; unit: QuotaUnit }
  | MeterBase & { kind: "level"; level: QuotaLevel }
  | MeterBase & { kind: "unlimited" }
  | MeterBase & { kind: "unread" };

export interface QuotaAccount {
  /** Opaque: the key of this account among the others, nothing to show. */
  id: string;
  provider: QuotaProvider;
  plan: string;
  scope: "" | "personal" | "org";
  region: string;
  label: string;
  source: string;
  state: QuotaState;
  reason: QuotaReason;
  observed_at: number;
  retry_at: number;
  meters: QuotaMeter[];
}

/**
 * What a projection reads. A published read-only snapshot satisfies it as well
 * as a freshly decoded one, so no reader has to be handed writable quota data.
 */
export type QuotaAccountRead = Omit<QuotaAccount, "meters"> & { readonly meters: readonly QuotaMeter[] };

const MAX_TIME = 4102444800;
const MAX_COUNT = 2 ** 53;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UNITS: readonly string[] = ["usd", "cny", "credits", "requests", "hours"];
const LEVELS: readonly string[] = ["full", "high", "medium", "low", "empty"];
const REASONS: Record<QuotaState, readonly string[]> = {
  ok: [""], partial: [""], throttled: [""],
  failed: ["unavailable", "timeout"],
  needs_action: ["relogin", "allow_keychain", "choose_account", "setup"],
  not_configured: ["no_login", "not_installed", "not_running", "unsupported_login"],
};
const METER_FIELDS: Record<QuotaMeter["kind"], readonly string[]> = {
  quota: ["kind", "name", "pool", "headline", "used_percent", "used", "limit", "scale", "unit", "window_minutes", "resets_at"],
  balance: ["kind", "name", "pool", "headline", "amount", "scale", "unit", "resets_at"],
  level: ["kind", "name", "pool", "headline", "level", "window_minutes", "resets_at"],
  unlimited: ["kind", "name", "pool", "headline", "window_minutes", "resets_at"],
  unread: ["kind", "name", "pool"],
};
const ACCOUNT_FIELDS = ["id", "provider", "plan", "scope", "region", "label", "source", "state", "reason", "observed_at", "retry_at", "meters"];

function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function integer(v: unknown, min: number, max: number): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max; }
function only(v: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(v).every(key => fields.includes(key)); }
/** An optional wire field: absent, or an integer in range. Zero is spelled by leaving it out. */
function optional(v: unknown, max: number): v is number | undefined { return v === undefined || integer(v, 1, max); }

function meter(v: unknown): QuotaMeter | null {
  if (!record(v) || typeof v.kind !== "string" || !Object.hasOwn(METER_FIELDS, v.kind)) return null;
  const kind = v.kind as QuotaMeter["kind"];
  if (!only(v, METER_FIELDS[kind]) || typeof v.name !== "string" || !v.name || v.name.length > 160
    || typeof v.pool !== "string" || !TOKEN.test(v.pool) || (v.headline !== undefined && v.headline !== true)
    || !optional(v.window_minutes, 525600) || !optional(v.resets_at, MAX_TIME) || !optional(v.scale, 6)) return null;
  const base: MeterBase = { name: v.name, pool: v.pool, headline: v.headline === true, window_minutes: v.window_minutes ?? 0, resets_at: v.resets_at ?? 0 };
  const scale = v.scale ?? 0;
  switch (kind) {
    case "quota": {
      if (typeof v.used_percent !== "number" || !Number.isFinite(v.used_percent) || v.used_percent < 0 || v.used_percent > 100) return null;
      const counted = v.used !== undefined || v.limit !== undefined || v.unit !== undefined || v.scale !== undefined;
      if (!counted) return { ...base, kind, used_percent: v.used_percent, count: null };
      // The counts behind a share come whole or not at all.
      if (!integer(v.used, 0, MAX_COUNT) || !integer(v.limit, 1, MAX_COUNT) || !UNITS.includes(v.unit as string)) return null;
      return { ...base, kind, used_percent: v.used_percent, count: { used: v.used, limit: v.limit, scale, unit: v.unit as QuotaUnit } };
    }
    case "balance":
      return integer(v.amount, 0, MAX_COUNT) && UNITS.includes(v.unit as string) ? { ...base, kind, amount: v.amount, scale, unit: v.unit as QuotaUnit } : null;
    case "level":
      return LEVELS.includes(v.level as string) ? { ...base, kind, level: v.level as QuotaLevel } : null;
    default:
      return { ...base, kind };
  }
}

function account(v: Record<string, unknown>): QuotaAccount | null {
  if (!only(v, ACCOUNT_FIELDS) || typeof v.id !== "string" || !TOKEN.test(v.id) || typeof v.plan !== "string" || v.plan.length > 80
    || (v.scope !== undefined && v.scope !== "personal" && v.scope !== "org")
    || (v.region !== undefined && (typeof v.region !== "string" || !/^[a-z0-9-]{1,16}$/.test(v.region)))
    || (v.label !== undefined && (typeof v.label !== "string" || !v.label || v.label.length > 80))
    || (v.source !== undefined && (typeof v.source !== "string" || !/^[a-z_]{1,32}$/.test(v.source)))
    || typeof v.state !== "string" || !Object.hasOwn(REASONS, v.state) || !REASONS[v.state as QuotaState].includes((v.reason ?? "") as string)
    || !integer(v.observed_at, 0, MAX_TIME) || !optional(v.retry_at, MAX_TIME) || !Array.isArray(v.meters) || v.meters.length > 32) return null;
  const state = v.state as QuotaState;
  const meters: QuotaMeter[] = [];
  for (const raw of v.meters) {
    const parsed = meter(raw);
    if (!parsed) return null;
    meters.push(parsed);
  }
  const unread = meters.filter(m => m.kind === "unread").length;
  // Numbers and their sample time come together, and only a read that worked or
  // one that kept an earlier sample carries them. Missing data is never zero.
  if ((meters.length > 0) !== (v.observed_at > 0)) return null;
  if ((state === "ok" || state === "partial") && !meters.length) return null;
  if ((state === "needs_action" || state === "not_configured") && meters.length) return null;
  if (state === "partial" ? !unread || unread === meters.length : unread > 0) return null;
  if (v.retry_at !== undefined && state !== "throttled") return null;
  return {
    id: v.id, provider: v.provider as QuotaProvider, plan: v.plan, scope: (v.scope ?? "") as QuotaAccount["scope"],
    region: (v.region ?? "") as string, label: (v.label ?? "") as string, source: (v.source ?? "") as string,
    state, reason: (v.reason ?? "") as QuotaReason, observed_at: v.observed_at, retry_at: v.retry_at ?? 0, meters,
  };
}

/**
 * Decode an AgentQuotaV2 result. An item whose provider this build does not
 * know is left out and counted, so one newer provider never blanks the page;
 * anything else that does not fit the schema refuses the whole answer.
 */
export function parseQuotaAccounts(value: unknown): { accounts: QuotaAccount[]; unknown: number } {
  const fail = (): never => { throw new ProtocolError("bad_frame", "Invalid quota response"); };
  if (!record(value) || !only(value, ["items"]) || !Array.isArray(value.items) || value.items.length > 64) return fail();
  const accounts: QuotaAccount[] = [];
  const ids = new Set<string>();
  let unknown = 0;
  for (const item of value.items as unknown[]) {
    if (!record(item) || typeof item.provider !== "string" || !TOKEN.test(item.provider)) return fail();
    if (!(QUOTA_PROVIDERS as readonly string[]).includes(item.provider)) { unknown++; continue; }
    const parsed = account(item);
    if (!parsed || ids.has(parsed.id)) return fail();
    ids.add(parsed.id);
    accounts.push(parsed);
  }
  return { accounts, unknown };
}
