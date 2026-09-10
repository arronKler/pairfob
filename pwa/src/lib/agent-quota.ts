import { ProtocolError } from "./protocol/errors";

export type QuotaStatus = "ok" | "stale" | "not_installed" | "not_logged_in" | "unsupported" | "unavailable" | "setup_required" | "auth_required" | "not_running";
export interface QuotaWindow {
  unlimited?: boolean;
  name: string;
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}
export interface AgentQuota {
  provider: "codex" | "claude" | "antigravity" | "copilot" | "cursor" | "grok";
  plan: string;
  status: QuotaStatus;
  source: "app_server" | "statusline" | "oauth" | "local_api" | "github_api" | "web_api";
  observed_at: number;
  windows: QuotaWindow[];
}
const sources: Record<AgentQuota["provider"], readonly string[]> = {
  codex: ["app_server"], claude: ["oauth", "statusline"], antigravity: ["local_api"], copilot: ["github_api"], cursor: ["web_api"], grok: ["oauth"],
};
const statuses: QuotaStatus[] = ["ok", "stale", "not_installed", "not_logged_in", "unsupported", "unavailable", "setup_required", "auth_required", "not_running"];
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function integer(v: unknown, max: number): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max; }
function text(v: unknown, max: number): v is string { return typeof v === "string" && v.length <= max; }
function validWindow(v: unknown): v is QuotaWindow {
  return record(v) && text(v.name, 160) && !!v.name && typeof v.used_percent === "number" && Number.isFinite(v.used_percent)
    && v.used_percent >= 0 && v.used_percent <= 100 && integer(v.window_minutes, 525600)
    && integer(v.resets_at, 4102444800) && (v.unlimited === undefined || typeof v.unlimited === "boolean")
    && (v.unlimited !== true || v.used_percent === 0);
}
export function parseAgentQuota(value: unknown): AgentQuota[] {
  const fail = (): never => { throw new ProtocolError("bad_frame", "Invalid quota response"); };
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 6) return fail();
  const providers = new Set<string>();
  return value.items.map((v: unknown) => {
    if (!record(v) || (typeof v.provider !== "string" || !Object.hasOwn(sources, v.provider)) || providers.has(v.provider)
      || !text(v.plan, 80) || !statuses.includes(v.status as QuotaStatus)
      || !sources[v.provider as AgentQuota["provider"]].includes(v.source as string)
      || !integer(v.observed_at, 4102444800) || !Array.isArray(v.windows) || v.windows.length > 32
      || !v.windows.every(validWindow) || ((v.status === "ok" || v.status === "stale") && (!v.observed_at || !v.windows.length))) return fail();
    providers.add(v.provider);
    return v as unknown as AgentQuota;
  });
}
/**
 * What a staleness check reads. A published read-only snapshot satisfies it as
 * well as a freshly parsed one, so a predicate never forces a caller to hand
 * over writable quota data.
 */
export type QuotaRead = Omit<AgentQuota, "windows"> & { windows: readonly QuotaWindow[] };

export function quotaIsStale(q: QuotaRead, now = Date.now()): boolean {
  return q.status === "stale" || now / 1000 - q.observed_at >= 900 || q.observed_at > now / 1000 + 60
    || q.windows.some((w) => w.resets_at > 0 && w.resets_at <= now / 1000);
}
