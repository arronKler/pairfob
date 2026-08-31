import { t } from "./i18n.ts";
import type { AgentTraceItem } from "./operations";

export type AgentTurn = {
  user?: AgentTraceItem;
  steps: AgentTraceItem[];
  replies: AgentTraceItem[];
};

const PATH_KEYS = ["path", "file_path", "file", "target_file", "filename", "targetFile"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const QUERY_KEYS = ["pattern", "query", "regex", "search", "q"];
const URL_KEYS = ["url", "uri"];
const PATCH_FILE = /(?:\*\*\* (?:Update|Add|Delete) File:\s*)(\S+)/;

export function groupAgentTurns(items: AgentTraceItem[]): AgentTurn[] {
  const turns: AgentTurn[] = [];
  let current: AgentTurn | null = null;
  const take = (): AgentTurn => {
    if (!current) {
      current = { steps: [], replies: [] };
      turns.push(current);
    }
    return current;
  };
  for (const item of items) {
    if (item.type === "user") {
      current = { user: item, steps: [], replies: [] };
      turns.push(current);
      continue;
    }
    if (item.type === "assistant") take().replies.push(item);
    else take().steps.push(item);
  }
  return turns;
}

/** Newest AgentTrace pages are a tail window; a long run can start mid-turn. */
export function firstTurnNeedsUser(items: AgentTraceItem[], nextCursor: string | null): boolean {
  if (!nextCursor || !items.length) return false;
  return !groupAgentTurns(items)[0]?.user;
}

export function turnKey(turn: AgentTurn): string {
  const user = turn.user?.text || "";
  const userPart = turn.user ? `u:${user.length}:${user.slice(0, 48)}` : "u:none";
  const first = turn.steps[0];
  if (first) {
    return `${userPart}:s:${first.type}:${first.name || ""}:${(first.text || first.input || "").slice(0, 24)}`;
  }
  const reply = turn.replies[0]?.text || "";
  return `${userPart}:r:${reply.length}:${reply.slice(0, 24)}`;
}

export function stepKey(item: AgentTraceItem): string {
  return [
    item.type,
    item.name || "",
    String((item.text || "").length),
    (item.text || "").slice(0, 48),
    (item.input || "").slice(0, 24),
    String(item.output?.length ?? 0),
  ].join(":");
}

export function processTitle(steps: AgentTraceItem[], live: boolean): string {
  if (live) return t("trace.running");
  const tools = steps.filter((step) => step.type === "tool").length;
  const thinking = steps.some((step) => step.type === "thinking");
  if (thinking && !tools) return t("trace.thinking");
  if (!thinking && tools === 1) return t("trace.oneTool");
  if (!thinking && tools > 1) return t("trace.nTools", { n: tools });
  if (thinking && tools === 1) return t("trace.thinkOne");
  if (thinking && tools > 1) return t("trace.thinkN", { n: tools });
  return t("trace.process");
}

function clip(text: string, max = 72): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || text.trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function asRecord(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pick(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = str(record[key]);
    if (value) return value;
  }
  return "";
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return parts.slice(-3).join("/");
}

export function toolSummary(item: AgentTraceItem): string {
  const name = (item.name || t("trace.tool")).trim();
  const record = asRecord(item.input);
  const command = pick(record, COMMAND_KEYS);
  if (command) return clip(command);
  const path = pick(record, PATH_KEYS);
  if (path) return `${name} ${shortPath(path)}`;
  const query = pick(record, QUERY_KEYS);
  if (query) return `${name} ${clip(query, 48)}`;
  const href = pick(record, URL_KEYS);
  if (href) return `${name} ${clip(href, 48)}`;
  const patch = item.input?.match(PATCH_FILE)?.[1];
  if (patch) return `${name} ${shortPath(patch)}`;
  if (item.input) {
    const compact = clip(item.input.replace(/\s+/g, " "), 56);
    return compact ? `${name} · ${compact}` : name;
  }
  if (item.text) return `${name} · ${clip(item.text, 48)}`;
  return name;
}

export function stepSummary(item: AgentTraceItem): string {
  if (item.type === "thinking") return t("trace.think");
  const label = toolSummary(item);
  if (item.type === "tool" && !item.output) return `${label} · ${t("trace.runningTool")}`;
  return label;
}
