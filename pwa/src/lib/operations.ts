import { ProtocolError } from "./protocol/errors.ts";
import { truncateUTF8Bytes } from "./text-budget.ts";

export const OPERATION_CAPABILITY_KEYS = [
  "create_conversation",
  "create_tab",
  "split_pane",
  "prompt_agent",
  "history",
  "list_worktrees",
  "create_worktree",
  "open_worktree",
  "resize_pane",
  "swap_pane",
  "zoom_pane",
] as const;

export type OperationCapability = typeof OPERATION_CAPABILITY_KEYS[number];
export type OperationCapabilities = Record<OperationCapability, boolean>;

export const NO_OPERATION_CAPABILITIES: OperationCapabilities = {
  create_conversation: false,
  create_tab: false,
  split_pane: false,
  prompt_agent: false,
  history: false,
  list_worktrees: false,
  create_worktree: false,
  open_worktree: false,
  resize_pane: false,
  swap_pane: false,
  zoom_pane: false,
};

export const OPERATION_INPUT_LIMITS = {
  cwd: 4096,
  path: 4096,
  label: 256,
  branch: 512,
  base: 512,
  prompt: 32768,
  agentKind: 32,
} as const;

/** Apply the protocol's byte limit without splitting a Unicode code point. */
export function fitOperationPrompt(value: string): { text: string; truncated: boolean } {
  const text = truncateUTF8Bytes(value, OPERATION_INPUT_LIMITS.prompt);
  return { text, truncated: text !== value };
}

export type RuntimeOperationsConfig = {
  capabilities: OperationCapabilities;
  agentKinds: string[];
};

export type CreateConversationInput = {
  cwd: string;
  agent_kind?: string;
  label?: string;
};

export type CreateConversationResult = {
  operation_id: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  agent_kind?: string;
  outcome: "applied";
};

export type CreateTabInput = { workspace_id: string; cwd?: string; label?: string };
export type SplitDirection = "right" | "down";
export type LayoutDirection = "left" | "right" | "up" | "down";
export type SplitPaneInput = { pane_id: string; direction: SplitDirection; cwd?: string; ratio?: number };
export type PromptAgentInput = { pane_id: string; text: string };
export type WorktreeScope =
  | { workspace_id: string; cwd?: never }
  | { workspace_id?: never; cwd: string };
export type ListWorktreesInput = WorktreeScope;
export type WorktreeDraft = WorktreeScope & {
  branch?: string;
  path?: string;
  label?: string;
};
export type CreateWorktreeInput = WorktreeDraft & { base?: string };
export type OpenWorktreeInput = WorktreeScope & (
  | { branch: string; path?: never }
  | { branch?: never; path: string }
) & { label?: string };
export type ResizePaneInput = { pane_id: string; direction: LayoutDirection; amount?: number };
export type SwapPaneInput = { pane_id: string; direction: LayoutDirection };
export type ZoomPaneInput = { pane_id: string; mode: "toggle" | "on" | "off" };

export type CreatedPaneResult = {
  operation_id: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  outcome: "applied";
};

export type MutationOutcome = "applied" | "noop";
export type PromptAgentResult = {
  operation_id: string;
  pane_id: string;
  agent_status: "blocked" | "working" | "idle" | "done" | "unknown";
  outcome: "applied";
};
export type WorktreeMutationResult = {
  operation_id: string;
  workspace_id: string;
  path: string;
  tab_id?: string;
  pane_id?: string;
  branch: string | null;
  outcome: MutationOutcome;
};
export type CreateWorktreeResult = WorktreeMutationResult & {
  tab_id: string;
  pane_id: string;
  outcome: "applied";
};
export type OpenWorktreeResult = WorktreeMutationResult;
export type LayoutMutationResult = {
  operation_id: string;
  pane_id: string;
  outcome: MutationOutcome;
};

export type HistoryItem = {
  role: "user" | "assistant";
  text: string;
};

export type HistoryPage = {
  items: HistoryItem[];
  nextCursor: string | null;
  truncated: boolean;
};

export type AgentTraceType = "user" | "thinking" | "tool" | "assistant";
export type AgentTraceItem = {
  type: AgentTraceType;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  toolState?: "running" | "done" | "error";
  detailRef?: string;
};
export type AgentTracePage = {
  items: AgentTraceItem[];
  nextCursor: string | null;
  truncated: boolean;
};
export type AgentTraceDetail = {
  detailRef: string;
  text?: string;
  input?: string;
  output?: string;
  truncated: boolean;
};

export type WorktreeSummary = {
  path: string;
  branch?: string;
  label?: string;
  openWorkspaceId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPERATION_ID = /^op_[A-Za-z0-9_-]{16,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const AGENT_KIND = /^[a-z][a-z0-9_-]*$/;

function badResult(message: string): never {
  throw new ProtocolError("bad_message", message);
}

function resultRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) badResult(`${operation} 响应不是对象`);
  return value;
}

function requiredString(result: Record<string, unknown>, key: string, pattern?: RegExp, maxLength?: number): string {
  const value = result[key];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value)) || (maxLength && value.length > maxLength)) {
    badResult(`响应缺少合法的 ${key}`);
  }
  return value;
}

function exactKeys(result: Record<string, unknown>, required: readonly string[], allowed = required): void {
  if (required.some((key) => !(key in result)) || Object.keys(result).some((key) => !allowed.includes(key))) {
    badResult("响应字段与协议不一致");
  }
}

function nullableString(result: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = result[key];
  if (value === null) return null;
  return requiredString(result, key, undefined, maxLength);
}

function optionalResourceID(result: Record<string, unknown>, key: string): string | undefined {
  if (!(key in result) || result[key] === undefined) return undefined;
  return requiredString(result, key, RESOURCE_ID);
}

function mutationBase(value: unknown, operation: string, expectedOperationID?: string): { result: Record<string, unknown>; operation_id: string; outcome: MutationOutcome } {
  const result = resultRecord(value, operation);
  const operation_id = requiredString(result, "operation_id", OPERATION_ID);
  if (expectedOperationID !== undefined && operation_id !== expectedOperationID) badResult(`${operation} 响应 operation_id 不匹配`);
  const outcome = result.outcome;
  if (outcome !== "applied" && outcome !== "noop") badResult(`${operation} 响应 outcome 非法`);
  return { result, operation_id, outcome };
}

export function parseCreateConversationResult(value: unknown, expectedOperationID?: string): CreateConversationResult {
  const { result, operation_id, outcome } = mutationBase(value, "CreateConversation", expectedOperationID);
  exactKeys(
    result,
    ["operation_id", "workspace_id", "tab_id", "pane_id", "outcome"],
    ["operation_id", "workspace_id", "tab_id", "pane_id", "outcome", "agent_kind"],
  );
  if (outcome !== "applied") badResult("CreateConversation 成功响应必须是 applied");
  const agentKind = result.agent_kind;
  if (agentKind !== undefined && (typeof agentKind !== "string" || !AGENT_KIND.test(agentKind) || agentKind.length > OPERATION_INPUT_LIMITS.agentKind)) {
    badResult("响应缺少合法的 agent_kind");
  }
  return {
    operation_id,
    workspace_id: requiredString(result, "workspace_id", RESOURCE_ID),
    tab_id: requiredString(result, "tab_id", RESOURCE_ID),
    pane_id: requiredString(result, "pane_id", RESOURCE_ID),
    ...(typeof agentKind === "string" ? { agent_kind: agentKind } : {}),
    outcome,
  };
}

function parseCreatedPaneResult(value: unknown, operation: string, expectedOperationID?: string): CreatedPaneResult {
  const { result, operation_id, outcome } = mutationBase(value, operation, expectedOperationID);
  exactKeys(result, ["operation_id", "workspace_id", "tab_id", "pane_id", "outcome"]);
  if (outcome !== "applied") badResult(`${operation} 成功响应必须是 applied`);
  return {
    operation_id,
    workspace_id: requiredString(result, "workspace_id", RESOURCE_ID),
    tab_id: requiredString(result, "tab_id", RESOURCE_ID),
    pane_id: requiredString(result, "pane_id", RESOURCE_ID),
    outcome,
  };
}

export const parseCreateTabResult = (value: unknown, expectedOperationID?: string): CreatedPaneResult => parseCreatedPaneResult(value, "CreateTab", expectedOperationID);
export const parseSplitPaneResult = (value: unknown, expectedOperationID?: string): CreatedPaneResult => parseCreatedPaneResult(value, "SplitPane", expectedOperationID);

export function parsePromptAgentResult(value: unknown, expectedOperationID?: string): PromptAgentResult {
  const { result, operation_id, outcome } = mutationBase(value, "PromptAgent", expectedOperationID);
  exactKeys(result, ["operation_id", "pane_id", "agent_status", "outcome"]);
  if (outcome !== "applied") badResult("PromptAgent 成功响应必须是 applied");
  const agent_status = requiredString(result, "agent_status");
  if (!(["blocked", "working", "idle", "done", "unknown"] as string[]).includes(agent_status)) badResult("PromptAgent 响应 agent_status 非法");
  return {
    operation_id,
    pane_id: requiredString(result, "pane_id", RESOURCE_ID),
    agent_status: agent_status as PromptAgentResult["agent_status"],
    outcome,
  };
}

function parseWorktreeMutationResult(value: unknown, operation: "CreateWorktree" | "OpenWorktree", expectedOperationID?: string): WorktreeMutationResult {
  const { result, operation_id, outcome } = mutationBase(value, operation, expectedOperationID);
  const required = operation === "CreateWorktree"
    ? ["operation_id", "workspace_id", "tab_id", "pane_id", "path", "branch", "outcome"]
    : ["operation_id", "workspace_id", "path", "branch", "outcome"];
  const allowed = operation === "CreateWorktree" ? required : [...required, "tab_id", "pane_id"];
  exactKeys(result, required, allowed);
  if (operation === "CreateWorktree" && outcome !== "applied") badResult("CreateWorktree 成功响应必须是 applied");
  const tab_id = optionalResourceID(result, "tab_id");
  const pane_id = optionalResourceID(result, "pane_id");
  const branch = nullableString(result, "branch", OPERATION_INPUT_LIMITS.branch);
  return {
    operation_id,
    workspace_id: requiredString(result, "workspace_id", RESOURCE_ID),
    path: requiredString(result, "path", undefined, OPERATION_INPUT_LIMITS.path),
    ...(tab_id ? { tab_id } : {}),
    ...(pane_id ? { pane_id } : {}),
    branch,
    outcome,
  };
}

export const parseCreateWorktreeResult = (value: unknown, expectedOperationID?: string): CreateWorktreeResult => parseWorktreeMutationResult(value, "CreateWorktree", expectedOperationID) as CreateWorktreeResult;
export const parseOpenWorktreeResult = (value: unknown, expectedOperationID?: string): OpenWorktreeResult => parseWorktreeMutationResult(value, "OpenWorktree", expectedOperationID);

function parseLayoutMutationResult(value: unknown, operation: string, expectedOperationID?: string): LayoutMutationResult {
  const { result, operation_id, outcome } = mutationBase(value, operation, expectedOperationID);
  exactKeys(result, ["operation_id", "pane_id", "outcome"]);
  return { operation_id, pane_id: requiredString(result, "pane_id", RESOURCE_ID), outcome };
}

export const parseResizePaneResult = (value: unknown, expectedOperationID?: string): LayoutMutationResult => parseLayoutMutationResult(value, "ResizePane", expectedOperationID);
export const parseSwapPaneResult = (value: unknown, expectedOperationID?: string): LayoutMutationResult => parseLayoutMutationResult(value, "SwapPane", expectedOperationID);
export const parseZoomPaneResult = (value: unknown, expectedOperationID?: string): LayoutMutationResult => parseLayoutMutationResult(value, "ZoomPane", expectedOperationID);

const RECONCILE_MUTATION_CODES = new Set(["unknown_outcome", "partial_failure", "bad_message"]);

/** Ambiguous or malformed mutation replies are reconciled with reads only; the mutation is never replayed. */
export async function reconcileMutationFailure(
  error: unknown,
  reads: { snapshot: () => Promise<unknown>; listWorktrees?: () => Promise<unknown> },
): Promise<boolean> {
  if (!(error instanceof ProtocolError) || !RECONCILE_MUTATION_CODES.has(error.code)) return false;
  await reads.snapshot().catch(() => undefined);
  if (reads.listWorktrees) await reads.listWorktrees().catch(() => undefined);
  return true;
}

export function parseRuntimeOperationsConfig(value: unknown): RuntimeOperationsConfig {
	if (!isRecord(value)) badResult("GetConfig 响应不是对象");
	const config = value;
	exactKeys(config, [
		"protocol", "build", "daemon_id", "hostname", "runtime", "vapid_public",
		"submit_keys", "idle_pause_ms", "push_delivery", "push_enabled", "agent_kinds", "capabilities",
	]);
	if (config.protocol !== 1) badResult("GetConfig protocol 不受支持");
	requiredString(config, "build", undefined, 256);
	requiredString(config, "daemon_id", undefined, 128);
	requiredString(config, "hostname", undefined, 255);
	if (config.runtime !== "herdr" && config.runtime !== "fake" && config.runtime !== "offline") badResult("GetConfig runtime 非法");
	if (typeof config.vapid_public !== "string" || Array.from(config.vapid_public).length > 256) badResult("GetConfig vapid_public 非法");
	if (!Array.isArray(config.submit_keys) || config.submit_keys.length !== 1 || config.submit_keys[0] !== "Enter") badResult("GetConfig submit_keys 非法");
	if (!Number.isSafeInteger(config.idle_pause_ms) || (config.idle_pause_ms as number) < 0) badResult("GetConfig idle_pause_ms 非法");
	if (config.push_delivery !== "webpush" || typeof config.push_enabled !== "boolean") badResult("GetConfig push 配置非法");

	const rawCapabilities = isRecord(config.capabilities) ? config.capabilities : {};
	const capabilities = { ...NO_OPERATION_CAPABILITIES };
	const capabilityKeys = Object.keys(rawCapabilities);
	const capabilitiesValid = capabilityKeys.length === OPERATION_CAPABILITY_KEYS.length
		&& capabilityKeys.every((key) => (OPERATION_CAPABILITY_KEYS as readonly string[]).includes(key))
		&& OPERATION_CAPABILITY_KEYS.every((key) => typeof rawCapabilities[key] === "boolean");
	if (!capabilitiesValid) badResult("GetConfig capabilities 非法");
	for (const key of OPERATION_CAPABILITY_KEYS) capabilities[key] = rawCapabilities[key] as boolean;

  const rawAgentKinds = Array.isArray(config.agent_kinds) ? config.agent_kinds : [];
  const agentKindsValid = rawAgentKinds.length <= 32
    && rawAgentKinds.every((kind) => typeof kind === "string" && AGENT_KIND.test(kind) && kind.length <= OPERATION_INPUT_LIMITS.agentKind)
    && new Set(rawAgentKinds).size === rawAgentKinds.length;
	if (!agentKindsValid) badResult("GetConfig agent_kinds 非法");
	const agentKinds = rawAgentKinds as string[];
	return { capabilities, agentKinds };
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mutation IDs are generated once per user action and are never reused for automatic replay. */
export function createOperationID(random = crypto.getRandomValues(new Uint8Array(12))): string {
  if (random.length !== 12) throw new RangeError("operation id entropy must be 12 bytes");
  return `op_${b64url(random)}`;
}

export function withOperationID<T extends object>(params: T, operationID = createOperationID()): T & { operation_id: string } {
  if (!/^op_[A-Za-z0-9_-]{16,128}$/.test(operationID)) throw new RangeError("invalid operation id");
  return { ...params, operation_id: operationID };
}

function itemText(value: unknown): HistoryItem | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== 2 || !("role" in value) || !("text" in value)) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.text !== "string" || !value.text || value.text.length > 131072) return null;
  return { role: value.role, text: value.text };
}

export function parseHistoryPage(value: unknown): HistoryPage {
  const result = resultRecord(value, "History");
  exactKeys(result, ["items", "next_cursor", "truncated"]);
  if (!Array.isArray(result.items) || result.items.length > 200) badResult("History 响应 items 非法");
  const items = result.items.map((item) => itemText(item));
  if (items.some((item) => item === null)) badResult("History 响应包含非法记录");
  const cursor = result.next_cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 1024)) badResult("History 响应 next_cursor 非法");
  if (typeof result.truncated !== "boolean") badResult("History 响应 truncated 非法");
  return { items: items as HistoryItem[], nextCursor: cursor, truncated: result.truncated };
}

const TRACE_TYPES = new Set<AgentTraceType>(["user", "thinking", "tool", "assistant"]);
const TRACE_KEYS = new Set(["type", "text", "name", "input", "output"]);

function optionalClipped(result: Record<string, unknown>, key: string): string | undefined {
  if (!(key in result) || result[key] === undefined) return undefined;
  const value = result[key];
  if (typeof value !== "string" || !value || value.length > 131072) badResult(`AgentTrace 响应 ${key} 非法`);
  return value;
}

function itemTrace(value: unknown): AgentTraceItem | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !TRACE_KEYS.has(key))) return null;
  if (typeof value.type !== "string" || !TRACE_TYPES.has(value.type as AgentTraceType)) return null;
  const type = value.type as AgentTraceType;
  const text = optionalClipped(value, "text");
  const name = optionalClipped(value, "name");
  const input = optionalClipped(value, "input");
  const output = optionalClipped(value, "output");
  if (type === "tool") {
    if (!name) return null;
    return { type, name, ...(text ? { text } : {}), ...(input ? { input } : {}), ...(output ? { output } : {}) };
  }
  if (!text) return null;
  if (name || input || output) return null;
  return { type, text };
}

export function parseAgentTracePage(value: unknown): AgentTracePage {
  const result = resultRecord(value, "AgentTrace");
  exactKeys(result, ["items", "next_cursor", "truncated"]);
  if (!Array.isArray(result.items) || result.items.length > 200) badResult("AgentTrace 响应 items 非法");
  const items = result.items.map((item) => itemTrace(item));
  if (items.some((item) => item === null)) badResult("AgentTrace 响应包含非法记录");
  const cursor = result.next_cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 1024)) badResult("AgentTrace 响应 next_cursor 非法");
  if (typeof result.truncated !== "boolean") badResult("AgentTrace 响应 truncated 非法");
  return { items: items as AgentTraceItem[], nextCursor: cursor, truncated: result.truncated };
}

function itemTraceSummary(value: unknown): AgentTraceItem | null {
  if (!isRecord(value) || typeof value.type !== "string" || !TRACE_TYPES.has(value.type as AgentTraceType)) return null;
  const type = value.type as AgentTraceType;
  if (type === "tool") {
    if (Object.keys(value).some((key) => !["type", "name", "state", "detail_ref"].includes(key))) return null;
    const name = optionalClipped(value, "name");
    const detailRef = optionalClipped(value, "detail_ref");
    const state = value.state;
    if (!name || !detailRef || detailRef.length > 1024 || (state !== "running" && state !== "done" && state !== "error")) return null;
    return { type, name, toolState: state, detailRef };
  }
  if (Object.keys(value).some((key) => !["type", "text"].includes(key))) return null;
  const text = optionalClipped(value, "text");
  return text ? { type, text } : null;
}

export function parseAgentTraceSummaryPage(value: unknown): AgentTracePage {
  const result = resultRecord(value, "AgentTraceSummary");
  exactKeys(result, ["items", "next_cursor", "truncated"]);
  if (!Array.isArray(result.items) || result.items.length > 200) badResult("AgentTraceSummary 响应 items 非法");
  const items = result.items.map((item) => itemTraceSummary(item));
  if (items.some((item) => item === null)) badResult("AgentTraceSummary 响应包含非法记录");
  const cursor = result.next_cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 1024)) badResult("AgentTraceSummary 响应 next_cursor 非法");
  if (typeof result.truncated !== "boolean") badResult("AgentTraceSummary 响应 truncated 非法");
  return { items: items as AgentTraceItem[], nextCursor: cursor, truncated: result.truncated };
}

export function parseAgentTraceDetail(value: unknown, expectedRef?: string): AgentTraceDetail {
  const result = resultRecord(value, "AgentTraceDetail");
  exactKeys(result, ["detail_ref", "truncated"], ["detail_ref", "text", "input", "output", "truncated"]);
  const detailRef = requiredString(result, "detail_ref", undefined, 1024);
  if (expectedRef !== undefined && detailRef !== expectedRef) badResult("AgentTraceDetail 响应 detail_ref 不匹配");
  if (typeof result.truncated !== "boolean") badResult("AgentTraceDetail 响应 truncated 非法");
  const text = optionalClipped(result, "text");
  const input = optionalClipped(result, "input");
  const output = optionalClipped(result, "output");
  return {
    detailRef,
    ...(text ? { text } : {}),
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    truncated: result.truncated,
  };
}

export function parseWorktrees(value: unknown): WorktreeSummary[] {
  const result = resultRecord(value, "ListWorktrees");
  exactKeys(result, ["worktrees"]);
  if (!Array.isArray(result.worktrees) || result.worktrees.length > 4096) badResult("ListWorktrees 响应 worktrees 非法");
  return result.worktrees.map((raw): WorktreeSummary => {
    const item = resultRecord(raw, "ListWorktrees item");
    const keys = ["path", "branch", "label", "is_bare", "is_detached", "is_prunable", "is_linked_worktree", "open_workspace_id"] as const;
    exactKeys(item, keys);
    const path = requiredString(item, "path", undefined, OPERATION_INPUT_LIMITS.path);
    const branch = nullableString(item, "branch", OPERATION_INPUT_LIMITS.branch);
    const label = nullableString(item, "label", OPERATION_INPUT_LIMITS.label);
    for (const key of ["is_bare", "is_detached", "is_prunable", "is_linked_worktree"] as const) {
      if (typeof item[key] !== "boolean") badResult(`ListWorktrees 响应 ${key} 非法`);
    }
    const openWorkspace = item.open_workspace_id === null
      ? null
      : requiredString(item, "open_workspace_id", RESOURCE_ID);
    return {
      path,
      ...(branch ? { branch } : {}),
      ...(label ? { label } : {}),
      ...(openWorkspace ? { openWorkspaceId: openWorkspace } : {}),
    };
  });
}

export function worktreeScope(workspaceID?: string, cwd?: string): WorktreeScope | null {
  if (workspaceID) return { workspace_id: workspaceID };
  if (cwd) return { cwd };
  return null;
}

export function openWorktreeFromSummary(scope: WorktreeScope, item: WorktreeSummary): OpenWorktreeInput | null {
  const label = item.label ? { label: item.label } : {};
  if (item.path) return { ...scope, path: item.path, ...label } as OpenWorktreeInput;
  if (item.branch) return { ...scope, branch: item.branch, ...label } as OpenWorktreeInput;
  return null;
}
