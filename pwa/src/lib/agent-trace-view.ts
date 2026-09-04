import { t } from "./i18n.ts";
import type { AgentTraceItem } from "./operations";

export type AgentTurn = {
  user?: AgentTraceItem;
  /** Source-ordered events after the user message. Never bucket by kind here. */
  items: AgentTraceItem[];
};

export type AgentTurnBlock = {
  type: "process" | "reply";
  items: AgentTraceItem[];
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
      current = { items: [] };
      turns.push(current);
    }
    return current;
  };
  for (const item of items) {
    if (item.type === "user") {
      current = { user: item, items: [] };
      turns.push(current);
      continue;
    }
    take().items.push(item);
  }
  return turns;
}

/** Preserve source order while coalescing only adjacent UI duties. */
export function groupAgentTurnBlocks(items: AgentTraceItem[]): AgentTurnBlock[] {
  const blocks: AgentTurnBlock[] = [];
  for (const item of items) {
    const type: AgentTurnBlock["type"] = item.type === "assistant" ? "reply" : "process";
    const last = blocks[blocks.length - 1];
    if (last?.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] });
  }
  return blocks;
}

/** Complete agent messages are separate prose blocks; streaming chunks merge in the journal first. */
export function replyText(items: AgentTraceItem[]): string {
  return items.map((item) => item.text || "").filter(Boolean).join("\n\n");
}

export type AgentTraceMerge = {
  items: AgentTraceItem[];
  /** Number of leading items from the later segment already present in the earlier one. */
  overlap: number;
};

/** Tail pages may repeat their owning user as context; keep that user at the source position once. */
export function mergeAgentTraceSegments(earlier: AgentTraceItem[], later: AgentTraceItem[]): AgentTraceMerge {
  const head = later[0];
  if (head?.type === "user") {
    for (let index = earlier.length - 1; index >= 0; index -= 1) {
      const item = earlier[index];
      if (item.type !== "user") continue;
      const priorTail = earlier.slice(index + 1);
      if (item.text === head.text && priorTail.at(-1)?.type !== "assistant") {
        return { items: [...earlier, ...later.slice(1)], overlap: 1 };
      }
      break;
    }
  }
  return { items: [...earlier, ...later], overlap: 0 };
}

/** Newest AgentTrace pages are a tail window; a long run can start mid-turn. */
export function firstTurnNeedsUser(items: AgentTraceItem[], nextCursor: string | null): boolean {
  if (!nextCursor || !items.length) return false;
  return !groupAgentTurns(items)[0]?.user;
}

export function turnKey(turn: AgentTurn): string {
  const user = turn.user?.text || "";
  const userPart = turn.user ? `u:${user.length}:${user.slice(0, 48)}` : "u:none";
  const first = turn.items[0];
  if (first) {
    return `${userPart}:s:${first.type}:${first.name || ""}:${(first.input || "").slice(0, 24)}`;
  }
  return userPart;
}

export function stepKey(item: AgentTraceItem, index = 0, scope = ""): string {
  return [
    scope,
    String(index),
    item.type,
    item.name || "",
    (item.input || "").slice(0, 24),
  ].join(":");
}

export type AgentToolState = "running" | "done" | "error";

/** Providers only expose an explicit error sentinel today; do not guess from arbitrary output. */
export function toolState(item: AgentTraceItem): AgentToolState {
  if (item.toolState) return item.toolState;
  if (!item.output) return "running";
  if (/^(?:失败|failed|error|errored)$/i.test(item.output.trim())) return "error";
  return "done";
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
  return toolSummary(item);
}
