import { displayText, displayTokens, displayWorktree } from "./agent-inspect";
import { t } from "./i18n.ts";
import type { AgentCard, ListGroup } from "./ranking.ts";

export type DashboardAgentCard = AgentCard & {
  /** True only when the runtime snapshot explicitly binds an Agent to this pane. */
  hasAgent: boolean;
};

export type SnapshotWire = {
  session?: unknown;
  focused?: { pane_id?: string; tab_id?: string; workspace_id?: string };
  layouts?: unknown;
  workspaces?: Array<{ workspace_id: string; label?: string; cwd?: string; tokens?: unknown; worktree?: unknown }>;
  tabs?: Array<{ tab_id: string; workspace_id: string; label?: string }>;
  panes?: Array<{
    pane_id?: string;
    workspace_id: string;
    tab_id?: string;
    cwd?: string;
    agent?: string;
    display_agent?: unknown;
    state_labels?: unknown;
    tokens?: unknown;
    agent_status?: string;
    label?: string | null;
    terminal_title?: string | null;
    history_available?: boolean;
    terminal_id?: unknown;
    agent_instance_id?: unknown;
    revision?: unknown;
    state_change_seq?: unknown;
    interactive_ready?: unknown;
    launch_pending?: unknown;
    scroll?: { viewport_rows?: number };
  }>;
};

/** Present wait/work/idle/done; missing or unrecognized wire status is unknown only when an agent is bound. */
function snapshotAgentStatus(hasAgent: boolean, wire: string | undefined, launching: boolean): AgentCard["status"] {
  if (!hasAgent) return "idle";
  if (launching && (wire === "working" || wire === "done")) return "idle";
  switch (wire) {
    case "blocked":
    case "working":
    case "idle":
    case "done":
      return wire;
    default:
      return "unknown";
  }
}

function boundedString(value: unknown, limit = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= limit ? text : undefined;
}

function safeCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function wireBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function mapSnapshotAgents(snapshot: SnapshotWire): DashboardAgentCard[] {
  const workspace = new Map((snapshot.workspaces || []).map((item) => [item.workspace_id, item]));
  const tabs = new Map((snapshot.tabs || []).map((item) => [item.tab_id, item]));
  return (snapshot.panes || [])
    .filter((pane) => Boolean(pane.pane_id))
    .map((pane) => {
      const ws = workspace.get(pane.workspace_id);
      const agent = pane.agent?.trim() || "";
      const hasAgent = agent !== "";
      return {
        paneId: pane.pane_id!,
        paneLabel: pane.label?.trim() || undefined,
        terminalTitle: pane.terminal_title?.trim() || undefined,
        tabId: pane.tab_id,
        tabLabel: pane.tab_id ? tabs.get(pane.tab_id)?.label?.trim() || undefined : undefined,
        workspaceId: pane.workspace_id,
        agent,
        hasAgent,
        displayAgent: displayText(pane.display_agent),
        stateLabels: displayTokens(pane.state_labels, true),
        tokens: displayTokens(pane.tokens),
        workspaceTokens: displayTokens(ws?.tokens),
        worktree: displayWorktree(ws?.worktree),
        status: snapshotAgentStatus(hasAgent, pane.agent_status, pane.launch_pending === true),
        workspaceLabel: ws?.label?.trim() || "",
        workspaceCwd: ws?.cwd?.trim() || undefined,
        cwd: pane.cwd || ws?.cwd || "",
        viewportRows: pane.scroll?.viewport_rows,
        historyAvailable: pane.history_available === true,
        terminalId: boundedString(pane.terminal_id),
        agentInstanceId: boundedString(pane.agent_instance_id),
        revision: safeCounter(pane.revision),
        stateChangeSeq: safeCounter(pane.state_change_seq),
        interactiveReady: wireBoolean(pane.interactive_ready),
        launchPending: wireBoolean(pane.launch_pending),
        runtimeSession: boundedString(snapshot.session),
      };
    });
}

/** Keep the open pane if it still exists. Never invent a selection. */
export function choosePane(current: string, agents: readonly AgentCard[], focused = ""): string {
  if (current && agents.some((agent) => agent.paneId === current)) return current;
  if (focused && agents.some((agent) => agent.paneId === focused)) return focused;
  return "";
}

export function cwdName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

const HIDDEN_TAB_LABELS = new Set(["main", "tab", "new tab", "unnamed tab", "未命名标签页"]);
const MACHINE_TITLES = new Set([
  "zsh",
  "bash",
  "sh",
  "fish",
  "nu",
  "csh",
  "tcsh",
  "node",
  "nodejs",
  "vim",
  "nvim",
  "emacs",
  "nano",
  "tmux",
  "screen",
  "python",
  "python3",
  "ruby",
  "perl",
  "ssh",
  "login",
  "shell",
  "terminal",
  "term",
]);

function same(left: string, right: string | undefined): boolean {
  if (!right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function alreadyShown(value: string, title: string, bits: string[]): boolean {
  if (bits.some((bit) => same(bit, value))) return true;
  return [title, ...title.split(" · ")].some((part) => same(part.trim(), value));
}

function placeLabel(agent: AgentCard): string {
  const dir = cwdName(agent.cwd);
  if (dir) return dir;
  const workspace = agent.workspaceLabel?.trim();
  if (workspace) return workspace;
  return "";
}

function conversationLabel(agent: AgentCard): string {
  const workspace = agent.workspaceLabel?.trim();
  if (!workspace) return "";
  const dir = cwdName(agent.cwd);
  if (dir && same(workspace, dir)) return "";
  return workspace;
}

function looksLikeMachineTitle(text: string, agent: AgentCard): boolean {
  const lower = text.toLowerCase();
  if (MACHINE_TITLES.has(lower)) return true;
  if (agent.agent && lower === agent.agent.trim().toLowerCase()) return true;
  if (
    lower === "终端" ||
    lower === "会话" ||
    lower === "未命名会话" ||
    lower === "窗格" ||
    lower === "未命名窗格" ||
    lower === "terminal" ||
    lower === "session" ||
    lower === "unnamed session" ||
    lower === "pane" ||
    lower === "unnamed pane"
  ) return true;
  if (/^[/~]/.test(text) || /^[a-z]:[\\/]/i.test(text) || text.includes("://")) return true;
  if (/^[^@\s]+@\S+/.test(text)) return true;
  if (text.includes("/") && !/\s/.test(text) && text.split("/").length >= 2) return true;
  if (agent.cwd && same(text, agent.cwd)) return true;
  if (same(text, cwdName(agent.cwd)) || same(text, agent.workspaceLabel)) return true;
  return false;
}

const OSC_STATUS = /^(?:[-–—•]\s*)?(?:Thinking|Waiting for response|Waiting|Working|Running)[.…]*\s*(?:[-–—]\s*)?/i;
const OSC_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]\s*/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop TUI status crumbs and a trailing " - grok" so the task name remains. */
function cleanOscTitle(text: string, agent: AgentCard): string {
  let named = text.trim().replace(OSC_SPINNER, "").trim();
  while (OSC_STATUS.test(named)) named = named.replace(OSC_STATUS, "").trim();
  named = named.replace(/^(?:[-–—]\s*)+/, "").trim();
  const who = agent.agent.trim();
  if (who) named = named.replace(new RegExp(`(?:\\s*[-–—]\\s*${escapeRegExp(who)})+$`, "i"), "").trim();
  return named;
}

function usefulTerminalTitle(agent: AgentCard): string {
  const raw = agent.terminalTitle?.trim() ?? "";
  if (!raw) return "";
  const text = cleanOscTitle(raw, agent);
  if (!text || looksLikeMachineTitle(text, agent)) return "";
  return text.length > 256 ? text.slice(0, 256) : text;
}

export function visibleTabLabel(label: string | undefined): string {
  const text = label?.trim() ?? "";
  if (!text || HIDDEN_TAB_LABELS.has(text.toLowerCase())) return "";
  return text;
}

function whoLabel(agent: AgentCard): string {
  return agent.agent.trim() || t("title.terminal");
}

export function agentTitle(agent: AgentCard, group: ListGroup = "flat"): string {
  const named = cleanOscTitle(agent.paneLabel?.trim() ?? "", agent);
  if (named && !looksLikeMachineTitle(named, agent)) return named;
  if (group !== "space") {
    const conversation = conversationLabel(agent);
    if (conversation) return conversation;
  }
  const hint = usefulTerminalTitle(agent);
  if (hint) return hint;
  return whoLabel(agent);
}

export function chromeName(agent: AgentCard): string {
  return agentTitle(agent);
}

/** Where a terminal runs, relative to its workspace root; empty at the root itself. */
function terminalDir(agent: AgentCard): string {
  const cwd = agent.cwd?.trim().replace(/\/+$/, "") ?? "";
  if (!cwd) return "";
  const root = agent.workspaceCwd?.trim().replace(/\/+$/, "") ?? "";
  if (root && cwd === root) return "";
  if (root && cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1);
  if (!root && same(cwdName(cwd), agent.workspaceLabel)) return "";
  return cwd;
}

/**
 * A plain terminal's second line: the command it runs and where, never a
 * status — a shell has no agent state to report.
 */
export function terminalMeta(agent: AgentCard, group: ListGroup = "flat"): string {
  const title = agentTitle(agent, group);
  const bits: string[] = [];
  const push = (value: string | undefined) => {
    const text = value?.trim() ?? "";
    if (!text || alreadyShown(text, title, bits)) return;
    bits.push(text);
  };
  push(cleanOscTitle(agent.terminalTitle?.trim() ?? "", agent));
  if (group !== "space") push(agent.workspaceLabel);
  push(terminalDir(agent));
  const tab = visibleTabLabel(agent.tabLabel);
  if (tab && !same(tab, agent.workspaceLabel)) push(tab);
  if (!bits.length) bits.push(t("title.terminal"));
  return bits.join(" · ");
}

export function agentMeta(agent: AgentCard, group: ListGroup = "flat"): string {
  const title = agentTitle(agent, group);
  const who = whoLabel(agent);
  const workspace = agent.workspaceLabel?.trim() || "";
  const dir = cwdName(agent.cwd);
  const place = placeLabel(agent);
  const tab = visibleTabLabel(agent.tabLabel);
  const bits: string[] = [];
  const push = (value: string | undefined) => {
    const text = value?.trim() ?? "";
    if (!text || alreadyShown(text, title, bits)) return;
    bits.push(text);
  };
  if (group !== "agent") push(who);
  if (group === "space") {
    if (dir && !same(dir, workspace)) push(dir);
  } else {
    push(place);
  }
  if (tab && !same(tab, workspace)) push(tab);
  if (!bits.length) {
    if (place && !same(place, title)) bits.push(place);
    else bits.push(who);
  }
  return bits.join(" · ");
}

export type AgentDetailRow = { key: string; value: string; kind?: "path" };

/** Full coordinates for the list object menu. The card subtitle stays short. */
export function agentDetailRows(agent: AgentCard, agents: AgentCard[] = [], group: ListGroup = "flat"): AgentDetailRow[] {
  const title = agentTitle(agent, group);
  const rows: AgentDetailRow[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: string | undefined, kind?: "path") => {
    const text = value?.trim() ?? "";
    if (!text) return;
    if (kind !== "path" && same(text, title)) return;
    const id = `${key}\0${text}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push(kind ? { key, value: text, kind } : { key, value: text });
  };
  push(t("detail.status"), agentStatusLabel(agent));
  push(t("detail.agent"), whoLabel(agent));
  push(t("detail.path"), agent.cwd, "path");
  push(t("detail.workspace"), agent.workspaceLabel);
  push(t("detail.tab"), visibleTabLabel(agent.tabLabel));
  push(t("detail.task"), usefulTerminalTitle(agent));
  if (tabIsSplit(agent, agents)) {
    push(t("detail.layout"), t("detail.splitCount", { n: tabSiblings(agent, agents).length }));
  }
  return rows;
}

export function herdSignature(agents: DashboardAgentCard[]): string {
  return JSON.stringify(
    agents.map((agent) => [
      agent.paneId,
      agent.paneLabel ?? null,
      agent.terminalTitle ?? null,
      agent.tabId ?? null,
      agent.tabLabel ?? null,
      agent.workspaceId ?? null,
      agent.agent,
      agent.hasAgent,
      agent.status,
      agent.workspaceLabel,
      agent.cwd,
      agent.viewportRows ?? null,
      agent.historyAvailable === true,
      agent.terminalId ?? null,
      agent.agentInstanceId ?? null,
      agent.revision ?? null,
      agent.stateChangeSeq ?? null,
      agent.interactiveReady ?? null,
      agent.launchPending ?? null,
      agent.runtimeSession ?? null,
    ]),
  );
}

export function tabSiblings(agent: AgentCard | undefined, agents: AgentCard[]): AgentCard[] {
  if (!agent) return [];
  if (agent.tabId) return agents.filter((item) => item.tabId === agent.tabId);
  return agents.filter((item) => item.paneId === agent.paneId);
}

export function workspaceSiblings(agent: AgentCard | undefined, agents: AgentCard[]): AgentCard[] {
  if (!agent?.workspaceId) return [];
  return agents.filter((item) => item.workspaceId === agent.workspaceId);
}

export function tabIsSplit(agent: AgentCard | undefined, agents: AgentCard[]): boolean {
  return tabSiblings(agent, agents).length > 1;
}

/** Zoom toggles the tab; only its matching runtime layout can describe that state. */
export function paneFillCopy(
  agent: AgentCard | undefined,
  agents: AgentCard[],
  layouts: ReadonlyArray<{ workspaceId: string; tabId: string; zoomed: boolean }>,
): { menu: string; aria: string } | null {
  if (!agent || !tabIsSplit(agent, agents)) return null;
  const layout = layouts.find(item => item.workspaceId === agent.workspaceId && item.tabId === agent.tabId);
  if (!layout) return null;
  const filled = layout.zoomed;
  if (filled) return { menu: t("fill.exit"), aria: t("fill.exitAria") };
  return { menu: t("fill.enter"), aria: t("fill.enterAria") };
}

export function canPromptAgent(agent: DashboardAgentCard | undefined): agent is DashboardAgentCard {
  return agent?.hasAgent === true && agent.launchPending !== true && agent.interactiveReady !== false;
}

export function agentStatusLabel(agent: AgentCard): string {
  if (agent.status === "blocked") return statusLabel(agent.status);
  if (agent.launchPending === true) return t("status.starting");
  if (agent.status === "working" || agent.status === "done" || agent.status === "unknown") return statusLabel(agent.status);
  if (agent.interactiveReady === false) return t("status.notReady");
  if (agent.status === "idle" && agent.interactiveReady === true) return t("status.ready");
  if (agent.status === "idle" && agent.agent.trim()) return t("status.waitingInput");
  return statusLabel(agent.status);
}

export function statusLabel(status: AgentCard["status"]): string {
  switch (status) {
    case "blocked":
      return t("status.blocked");
    case "working":
      return t("status.working");
    case "done":
      return t("status.done");
    case "idle":
      return t("status.idle");
    case "unknown":
      return t("status.unknown");
  }
}
