import { quotaIsStale, type AgentQuota } from "../lib/agent-quota";

export function quotaOverview(q: AgentQuota | undefined): number | "unlimited" | null {
  if (!q || q.status !== "ok" || quotaIsStale(q)) return null;
  const windows = q.provider === "copilot" ? q.windows.filter(w => w.name === "premium interactions") : q.windows;
  if (!windows.length) return null;
  const limited = windows.filter(w => !w.unlimited);
  return limited.length ? Math.min(...limited.map(w => 100 - w.used_percent)) : "unlimited";
}
