import type { AgentQuota } from "../src/lib/agent-quota";
import type { QuotaAccount, QuotaMeter } from "../src/lib/agent-quota-v2";
import { FIXED_NOW } from "./environment";

/**
 * Quota fixtures: the settled page, then one set per thing the page has to
 * survive (many accounts, every meter kind, every card state, an older computer).
 */

const sec = () => Math.floor(FIXED_NOW / 1000);

function account(id: string, provider: QuotaAccount["provider"], patch: Partial<QuotaAccount>): QuotaAccount {
  return { id, provider, plan: "", scope: "", region: "", label: "", source: "", state: "ok", reason: "", observed_at: sec() - 60, retry_at: 0, meters: [], ...patch };
}

function quota(name: string, used: number, minutes: number, resetIn: number, patch: Partial<Extract<QuotaMeter, { kind: "quota" }>> = {}): QuotaMeter {
  return { kind: "quota", name, pool: "plan", headline: true, used_percent: used, count: null, window_minutes: minutes, resets_at: resetIn ? sec() + resetIn : 0, ...patch };
}

const HOUR = 3600;
const DAY = 86400;

const off = (id: string, provider: QuotaAccount["provider"], state: "needs_action" | "not_configured", reason: QuotaAccount["reason"]): QuotaAccount =>
  account(id, provider, { state, reason, observed_at: 0 });

const claudeModels = (): QuotaMeter[] => [
  quota("seven day sonnet", 10, 10080, 5 * DAY, { pool: "seven-day-sonnet", headline: false }),
  quota("seven day opus", 88, 10080, 5 * DAY, { pool: "seven-day-opus", headline: false }),
  quota("seven day routines", 0, 10080, 5 * DAY, { pool: "seven-day-routines", headline: false }),
];

/** The settled page: five accounts with numbers, one login to renew, one app that is not open. */
export function quotas(): QuotaAccount[] {
  return [
    account("codex", "codex", { plan: "Pro", observed_at: sec() - 30, meters: [quota("codex", 28, 300, 2 * HOUR), quota("codex", 54, 10080, 4 * DAY)] }),
    account("claude", "claude", { plan: "Max", meters: [quota("five hour", 61, 300, 3 * HOUR), quota("seven day", 19, 10080, 5 * DAY), ...claudeModels()] }),
    account("antigravity", "antigravity", { state: "not_configured", reason: "not_running", observed_at: 0 }),
    account("copilot", "copilot", { plan: "Pro", observed_at: sec() - 20, meters: [
      { kind: "unlimited", name: "premium interactions", pool: "premium-interactions", headline: true, window_minutes: 0, resets_at: sec() + 18 * DAY },
      quota("chat", 0, 0, 18 * DAY, { pool: "chat", headline: false }),
      quota("completions", 12, 0, 18 * DAY, { pool: "completions", headline: false }),
    ] }),
    account("cursor", "cursor", { plan: "Pro", meters: [quota("Included plan", 45, 0, 9 * DAY)] }),
    account("deepseek", "deepseek", { source: "api", meters: [
      { kind: "balance", name: "balance", pool: "cny", headline: true, amount: 21139, scale: 2, unit: "cny", window_minutes: 0, resets_at: 0 },
    ] }),
    off("grok", "grok", "needs_action", "relogin"),
  ];
}

/** More accounts than the settings module shows, two of them low, two that need the reader. */
export function manyQuotas(): QuotaAccount[] {
  return [
    account("codex", "codex", { plan: "Pro", meters: [quota("codex", 28, 300, 2 * HOUR), quota("codex", 54, 10080, 4 * DAY)] }),
    account("codex-team", "codex", { plan: "Team", scope: "org", label: "acme", meters: [quota("codex", 91, 300, 47 * 60), quota("codex", 66, 10080, 3 * DAY)] }),
    account("claude", "claude", { plan: "Max", meters: [quota("five hour", 61, 300, 3 * HOUR), quota("seven day", 19, 10080, 5 * DAY), ...claudeModels()] }),
    account("claude-work", "claude", { plan: "Team", scope: "org", meters: [quota("five hour", 12, 300, 4 * HOUR), quota("seven day", 40, 10080, 2 * DAY)] }),
    account("antigravity", "antigravity", { state: "not_configured", reason: "not_running", observed_at: 0 }),
    off("copilot", "copilot", "needs_action", "choose_account"),
    account("cursor", "cursor", { plan: "Pro", meters: [quota("Included plan", 45, 0, 9 * DAY)] }),
    account("cursor-cn", "cursor", { plan: "Pro", region: "cn", meters: [quota("Included plan", 94, 0, 12 * DAY)] }),
    account("grok-team", "grok", { plan: "SuperGrok", label: "team@example.com", meters: [quota("Shared subscription quota", 36, 10080, 6 * DAY)] }),
    off("grok", "grok", "needs_action", "relogin"),
    account("opencode-go", "opencode-go", { source: "api", meters: [
      quota("five hour", 12.5, 300, 4 * HOUR),
      quota("seven day", 83, 10080, 3 * DAY),
      quota("monthly", 100, 0, 12 * DAY),
    ] }),
    account("command-code", "command-code", { plan: "Individual Goat", source: "api", meters: [
      quota("five hour", 7, 300, 2 * HOUR, { count: { used: 98, limit: 1400, scale: 2, unit: "usd" } }),
      quota("seven day", 54.5, 10080, 4 * DAY, { count: { used: 1906, limit: 3500, scale: 2, unit: "usd" } }),
      { kind: "balance", name: "monthly balance", pool: "usd", headline: true, amount: 5343, scale: 2, unit: "usd", window_minutes: 0, resets_at: sec() + 12 * DAY },
    ] }),
  ];
}

/** One row of every kind a meter can be, in one card and in the settings module. */
export function kindQuotas(): QuotaAccount[] {
  return [
    account("codex", "codex", { plan: "Pro", meters: [
      quota("codex", 28, 300, 2 * HOUR),
      quota("premium requests", 38, 0, 18 * DAY, { count: { used: 188, limit: 500, scale: 0, unit: "requests" } }),
      { kind: "balance", name: "top up", pool: "top-up", headline: false, amount: 1240, scale: 2, unit: "usd", window_minutes: 0, resets_at: 0 },
      { kind: "level", name: "model quota", pool: "model", headline: false, level: "low", window_minutes: 0, resets_at: 0 },
      { kind: "unlimited", name: "completions", pool: "completions", headline: false, window_minutes: 0, resets_at: 0 },
      quota("seven day opus", 40, 10080, -HOUR, { pool: "seven-day-opus", headline: false }),
    ] }),
    account("claude", "claude", { plan: "Max", meters: [
      { kind: "level", name: "model quota", pool: "model", headline: true, level: "medium", window_minutes: 0, resets_at: 0 },
      { kind: "balance", name: "monthly credits", pool: "credits", headline: false, amount: 1280, scale: 0, unit: "credits", window_minutes: 0, resets_at: sec() + 12 * DAY },
    ] }),
    account("cursor", "cursor", { plan: "Pro", meters: [
      { kind: "balance", name: "top up", pool: "top-up", headline: true, amount: 3050, scale: 2, unit: "cny", window_minutes: 0, resets_at: 0 },
    ] }),
    account("copilot", "copilot", { plan: "Pro", meters: [
      { kind: "level", name: "model quota", pool: "model", headline: true, level: "empty", window_minutes: 0, resets_at: 0 },
    ] }),
    account("grok", "grok", { plan: "SuperGrok", meters: [quota("Shared subscription quota", 100, 10080, -60)] }),
    off("antigravity", "antigravity", "not_configured", "not_running"),
  ];
}

/** Every way a read can come back short: part of it, late, refused for rate, refused for login. */
export function partialQuotas(): QuotaAccount[] {
  return [
    account("claude", "claude", { plan: "Max", state: "partial", observed_at: sec() - 10, meters: [
      quota("five hour", 36, 300, 3 * HOUR),
      { kind: "unread", name: "top up", pool: "top-up", headline: false, window_minutes: 0, resets_at: 0 },
    ] }),
    account("codex", "codex", { plan: "Pro", state: "failed", reason: "timeout", observed_at: sec() - 480,
      meters: [quota("codex", 28, 300, 2 * HOUR), quota("codex", 54, 10080, 4 * DAY)] }),
    account("cursor", "cursor", { plan: "Pro", state: "throttled", observed_at: sec() - 360, retry_at: sec() + 180,
      meters: [quota("Included plan", 94, 0, 12 * DAY)] }),
    off("grok", "grok", "needs_action", "relogin"),
    account("copilot", "copilot", { state: "failed", reason: "unavailable", observed_at: 0 }),
    off("antigravity", "antigravity", "not_configured", "not_running"),
  ];
}

/** What a computer that only knows the first quota operation answers. */
export function legacyQuotas(): AgentQuota[] {
  return [
    { provider: "codex", plan: "Pro", status: "ok", source: "app_server", observed_at: sec() - 30,
      windows: [{ name: "codex", used_percent: 28, window_minutes: 300, resets_at: sec() + 2 * HOUR }, { name: "codex", used_percent: 54, window_minutes: 10080, resets_at: sec() + 4 * DAY }] },
    { provider: "claude", plan: "Max", status: "ok", source: "statusline", observed_at: sec() - 60,
      windows: [{ name: "five_hour", used_percent: 61, window_minutes: 300, resets_at: sec() + 3 * HOUR }] },
    { provider: "copilot", plan: "Pro", status: "ok", source: "github_api", observed_at: sec() - 20,
      windows: [{ name: "premium interactions", used_percent: 0, window_minutes: 0, resets_at: 0, unlimited: true }, { name: "chat", used_percent: 0, window_minutes: 0, resets_at: 0, unlimited: true }] },
    { provider: "cursor", plan: "Pro", status: "stale", source: "web_api", observed_at: sec() - 3600,
      windows: [{ name: "Included plan", used_percent: 45, window_minutes: 0, resets_at: sec() + 10 * DAY }] },
    { provider: "antigravity", plan: "", status: "not_running", source: "local_api", observed_at: 0, windows: [] },
    { provider: "grok", plan: "", status: "auth_required", source: "oauth", observed_at: 0, windows: [] },
  ];
}
