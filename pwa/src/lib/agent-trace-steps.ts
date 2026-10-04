import { t, type CopyKey } from "./i18n.ts";
import type { AgentTraceItem } from "./operations";
import { groupAgentTurns, toolState, toolSummary, turnKey, type AgentTurn } from "./agent-trace-view";

/**
 * What one turn's steps mean to a reader on a phone: a kind per step (from the
 * tool name every agent reports), a short target, and a result-first summary.
 * Pure: no DOM, no stores.
 */
export type StepCategory = "read" | "search" | "edit" | "command" | "web" | "subtask" | "plan" | "question" | "mcp" | "think" | "other";

/** Tool names as Claude Code, Codex, Grok and Pi write them, lowercased. */
const CATEGORY_NAMES: ReadonlyArray<readonly [StepCategory, readonly string[]]> = [
  ["read", ["read", "read_file", "list_dir", "ls", "view", "notebookread", "view_image"]],
  ["search", ["grep", "glob", "search", "find", "rg", "file_search", "codebase_search", "toolsearch"]],
  ["edit", ["edit", "write", "multiedit", "apply_patch", "notebookedit", "str_replace", "create_file"]],
  ["command", ["bash", "exec_command", "exec", "shell", "run_terminal_command", "write_stdin", "bashoutput", "killshell", "monitor"]],
  ["web", ["webfetch", "websearch", "web_search", "browser", "fetch"]],
  ["subtask", ["task", "agent", "get_command_or_subagent_output", "spawn_agent", "sendmessage"]],
  ["plan", ["todowrite", "update_plan"]],
  ["question", ["askuserquestion", "request_user_input_async", "request_user_input"]],
];

export function stepCategory(item: AgentTraceItem): StepCategory {
  if (item.type === "thinking") return "think";
  const name = (item.name || "").toLowerCase();
  if (name.startsWith("mcp__")) return "mcp";
  for (const [category, names] of CATEGORY_NAMES) if (names.includes(name)) return category;
  return "other";
}

export function categoryLabel(category: StepCategory): string {
  return t(`work.cat.${category}` as CopyKey);
}

function lastSegments(path: string, count = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= count ? path : parts.slice(-count).join("/");
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * Codex reads a running command through write_stdin (nearly always with nothing
 * to type); as a step name it says nothing. Code mode labels the call by its
 * tool name, with " +N" for further calls in the same snippet.
 */
const COMMAND_OUTPUT = /^write_stdin( \+\d+)?$/;

/** The step's target in a few words: a path tail, a command line, a query. */
export function stepObject(item: AgentTraceItem): string {
  if (item.type === "thinking") return firstLine(item.text || "");
  const category = stepCategory(item);
  const name = item.name || "";
  if (category === "mcp") {
    const [, server = "", tool = ""] = name.split("__");
    return [server, tool].filter(Boolean).join(" · ") + (item.label ? ` · ${firstLine(item.label)}` : "");
  }
  if (item.label) {
    const label = firstLine(item.label);
    const output = COMMAND_OUTPUT.exec(label);
    if (output) return t("work.commandOutput") + (output[1] ?? "");
    if (category === "read" || category === "edit") {
      // "path/to/file.ts +2" keeps the extra-file count after the shortened path.
      const [path, more] = label.split(/ (?=\+\d+$)/);
      return more ? `${lastSegments(path)} ${more}` : lastSegments(path);
    }
    return label;
  }
  if (name.toLowerCase() === "write_stdin") return t("work.commandOutput");
  // Older daemons send no label; a full AgentTrace still carries the input.
  if (item.input) return toolSummary(item);
  return name;
}

export type StepState = "running" | "done" | "error" | "ended";

/** Without trace_labels the daemon cannot report Claude/Codex failures, so "done" is only "ended". */
export function stepState(item: AgentTraceItem, verified: boolean): StepState {
  const state = toolState(item);
  return state === "done" && !verified ? "ended" : state;
}

export type TurnTone = "running" | "waiting" | "stale" | "interrupted" | "error" | "done" | "neutral";
export type TurnOutcome = { tone: TurnTone; title: string; detail: string; steps: number };
export type TurnContext = { live: boolean; waiting: boolean; stale: boolean; verified: boolean; hasNext?: boolean };

function editedFiles(tools: readonly AgentTraceItem[]): string[] {
  const files: string[] = [];
  for (const tool of tools) {
    if (stepCategory(tool) !== "edit" || !tool.label) continue;
    const path = firstLine(tool.label).replace(/ \+\d+$/, "");
    if (!files.includes(path)) files.push(path);
  }
  return files;
}

function latestPlan(tools: readonly AgentTraceItem[]): string {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (stepCategory(tool) === "plan" && tool.label && /^\d+\/\d+$/.test(tool.label)) return tool.label;
  }
  return "";
}

/** The turn stopped on a failed step: nothing ran and nothing was said after it. */
function endedOnFailure(items: readonly AgentTraceItem[]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "tool") return toolState(item) === "error";
    if (item.type === "assistant") return false;
  }
  return false;
}

/**
 * Result first: waiting on you, then what changed, then size. A failed step the
 * agent worked past is routine and stays in the step list; only a turn that
 * stopped on one says so. Reading and searching only show once the card is open.
 */
export function turnOutcome(items: readonly AgentTraceItem[], context: TurnContext): TurnOutcome {
  const tools = items.filter((item) => item.type === "tool");
  const steps = tools.length;
  const total = steps ? t("work.total", { n: steps }) : "";
  const files = editedFiles(tools);
  const edits = tools.filter((tool) => stepCategory(tool) === "edit").length;
  const plan = latestPlan(tools);
  const planPart = plan ? t("work.plan", { progress: plan }) : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  if (items.some((item) => item.type === "interrupt")) {
    return { tone: "interrupted", title: t("work.interrupted"), detail: steps ? total : t("work.notStarted"), steps };
  }
  if (context.live && context.stale) return { tone: "stale", title: t("work.stale"), detail: total, steps };
  if (context.live && context.waiting) return { tone: "waiting", title: t("work.waiting"), detail: join(planPart, total), steps };
  if (context.live) {
    const running = tools.filter((tool) => toolState(tool) === "running").length;
    const title = running > 1 ? t("work.runningMany", { n: running }) : steps ? t("work.running", { n: steps }) : t("work.starting");
    return { tone: "running", title, detail: join(files.length ? t("work.changedFiles", { n: files.length }) : "", planPart), steps };
  }
  const changed = files.length ? t("work.changedFiles", { n: files.length }) : edits ? t("work.edits", { n: edits }) : "";
  if (!context.hasNext && endedOnFailure(items)) {
    return { tone: "error", title: t("work.endedFailed"), detail: join(stepObject(tools[tools.length - 1]), changed, planPart, total), steps };
  }
  const tone: TurnTone = context.verified ? "done" : "neutral";
  if (changed) {
    const first = files[0] ? lastSegments(files[0], 1) : "";
    return { tone, title: changed, detail: join(files.length === 1 ? first : "", planPart, total), steps };
  }
  return { tone, title: steps ? t("work.doneSteps", { n: steps }) : t("work.done"), detail: planPart, steps };
}

export type PendingAsk = { verb: string; object: string };

/** What a blocked agent is waiting to do: the tool still running in the last turn. */
export function pendingAsk(items: readonly AgentTraceItem[]): PendingAsk | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "tool" || toolState(item) !== "running") continue;
    const category = stepCategory(item);
    const verb = category === "command" ? t("needs.run") : category === "edit" ? t("needs.edit")
      : category === "question" ? t("needs.ask") : t("needs.tool", { name: item.name || "" });
    return { verb, object: stepObject(item) };
  }
  return null;
}

/** A turn's span from its own records' times (the prompt, else its first stamped item). */
export function turnSpan(head: AgentTraceItem | undefined, items: readonly AgentTraceItem[]): { start?: number; end?: number } {
  const stamped = items.filter((item) => item.at !== undefined);
  const start = head?.at ?? stamped[0]?.at;
  const end = stamped.at(-1)?.at;
  return { start, end: end !== undefined && start !== undefined && end >= start ? end : undefined };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("time.seconds", { s: seconds });
  if (seconds < 3600) return t("time.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
  return t("time.hours", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
}

/**
 * A turn's parts: the steps (thinking, tools, interim notes) go in the card;
 * the trailing agent text is the reply, or, while the turn runs, the latest
 * note under the card. Markers are facts about the turn, not entries.
 */
export function splitTurn(turn: AgentTurn) {
  const content = turn.items.filter((item) => item.type !== "compaction" && item.type !== "interrupt");
  let tail = content.length;
  while (tail > 0 && content[tail - 1].type === "assistant") tail -= 1;
  return {
    entries: content.slice(0, tail),
    reply: content.slice(tail),
    compacted: turn.items.some((item) => item.type === "compaction"),
    interrupted: turn.items.some((item) => item.type === "interrupt"),
  };
}

export type TurnRef = { key: string; ordinal: number };

/** The current steps of the turn a sheet was opened from, or null once it is gone. */
export function turnEntries(items: readonly AgentTraceItem[], ref: TurnRef): AgentTraceItem[] | null {
  const turn = groupAgentTurns(items).filter((candidate) => turnKey(candidate) === ref.key)[ref.ordinal];
  return turn ? splitTurn(turn).entries : null;
}
