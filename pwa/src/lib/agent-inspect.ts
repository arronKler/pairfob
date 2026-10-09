import { ProtocolError } from "./protocol/errors";
import type { AgentCard, AgentStatus, DisplayMetadata } from "./ranking";
export type { DisplayMetadata } from "./ranking";

export type AgentInspection = {
  status: AgentStatus;
  manifest_source?: string;
  manifest_version?: string;
  matched_rule?: string;
  fallback_reason?: string;
  skipped_reason?: string;
  screen_detection_skipped: boolean;
  warning?: string;
  rules: Array<{ id: string; state: AgentStatus; matched: boolean }>;
};
const statuses = new Set(["idle", "working", "blocked", "done", "unknown"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function displayText(v: unknown): string | undefined {
  return typeof v === "string" ? [...v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, 256).join("") || undefined : undefined;
}
export function displayTokens(v: unknown, states = false): Record<string, string> | undefined {
  if (!record(v)) return undefined;
  const entries = Object.entries(v).filter(([key]) => /^[A-Za-z0-9_-]{1,32}$/.test(key) && (!states || statuses.has(key)))
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, 32)
    .flatMap(([key, value]) => { const text = displayText(value); return text ? [[key, text]] : []; });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
export function displayWorktree(v: unknown): DisplayMetadata["worktree"] {
  if (!record(v)) return undefined;
  const repo = displayText(v.repo_name), path = displayText(v.checkout_path);
  return repo && path && typeof v.is_linked_worktree === "boolean"
    ? { repo_name: repo, checkout_path: path, is_linked_worktree: v.is_linked_worktree } : undefined;
}
export function agentObservationKey(agent: AgentCard): string {
  return JSON.stringify([agent.runtimeSession || "", agent.paneId, agent.terminalId || "", agent.agentInstanceId || ""]);
}
export function agentDisplaySummary(agent: AgentCard, title = ""): string {
  // Presentation only: never replace the canonical kind or semantic status.
  return [agent.displayAgent, agent.worktree?.repo_name, agent.tokens?.task, agent.tokens?.phase]
    .filter((value, index, all) => value && value !== title && all.indexOf(value) === index).join(" · ");
}
export function parseAgentInspection(value: unknown): AgentInspection {
  const bad = (): never => { throw new ProtocolError("invalid_response", "Invalid agent inspection"); };
  if (!record(value) || !statuses.has(String(value.status)) || typeof value.screen_detection_skipped !== "boolean"
    || !Array.isArray(value.rules) || value.rules.length > 32) return bad();
  const fields = new Set(["status", "screen_detection_skipped", "rules", "manifest_source", "manifest_version", "matched_rule", "fallback_reason", "skipped_reason", "warning"]);
  if (Object.keys(value).some(key => !fields.has(key))) return bad();
  const result: AgentInspection = { status: value.status as AgentStatus, screen_detection_skipped: value.screen_detection_skipped, rules: [] };
  for (const key of ["manifest_source", "manifest_version", "matched_rule", "fallback_reason", "skipped_reason", "warning"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || [...value[key] as string].length > 256)) return bad();
    result[key] = displayText(value[key]);
  }
  for (const rule of value.rules) {
    if (!record(rule) || Object.keys(rule).some(key => !["id", "state", "matched"].includes(key)) || typeof rule.id !== "string" || [...rule.id].length > 256 || !statuses.has(String(rule.state)) || typeof rule.matched !== "boolean") return bad();
    result.rules.push({ id: displayText(rule.id) || "", state: rule.state as AgentStatus, matched: rule.matched });
  }
  return result;
}
