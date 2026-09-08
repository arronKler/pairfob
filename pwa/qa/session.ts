import { ProtocolError } from "../src/lib/protocol/errors";
import { NO_OPERATION_CAPABILITIES } from "../src/lib/operations";
import type { LiveSession, SessionEvent } from "../src/lib/protocol/session-types";
import { state } from "../src/state";
import { FIXED_NOW, record } from "./environment";
import type { FixtureTerminalFrame } from "./types";
import * as data from "./data";

export type FixtureSession = {
  live: LiveSession;
  emit(event: SessionEvent): void;
  terminalFrame(text: string, options?: FixtureTerminalFrame): boolean;
  setConnected(connected: boolean): void;
  hold(method: string): void;
  release(method: string): void;
  failNext(method: string, code: string): void;
  dispose(): void;
};

/** Every request is local and logged. Holds/errors allow deliberate async interaction probes. */
export function createSession(): FixtureSession {
  let connected = true;
  let disposed = false;
  let operation = 0;
  let text = data.PANE_TEXT;
  let hash = 1;
  let terminalSerial = 0;
  let terminal: { id: string; cols: number; rows: number; sequence: bigint } | null = null;
  const listeners = new Set<(event: SessionEvent) => void>();
  const held = new Set<string>();
  const waiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  const failures = new Map<string, string>();
  const snapshot = data.snapshot();
  const deviceList = data.devices();
  const capabilities = Object.fromEntries(Object.keys(NO_OPERATION_CAPABILITIES).map((key) => [key, true]));
  const emit = (event: SessionEvent) => { for (const listener of listeners) listener(event); };
  const op = () => `op_qa_${String(++operation).padStart(12, "0")}`;
  const created = () => ({ operation_id: op(), workspace_id: "w1", tab_id: "w1:t1", pane_id: data.PANE, outcome: "applied" });
  const request = async <T>(method: string, args: unknown[], run: () => T | Promise<T>, mutation = false): Promise<T> => {
    record(mutation ? "mutation" : "read", method, args);
    if (held.has(method)) await new Promise<void>((resolve, reject) => {
      const list = waiters.get(method) ?? [];
      list.push({ resolve, reject });
      waiters.set(method, list);
    });
    if (disposed) throw new ProtocolError("conflict", "QA scene was replaced");
    const failure = failures.get(method);
    if (failure) { failures.delete(method); throw new ProtocolError(failure, `QA ${method}: ${failure}`); }
    return run();
  };
  const mutation = (method: string, args: unknown[], run: () => unknown = () => ({ operation_id: op(), outcome: "applied" })) => request(method, args, run, true);
  const live = {
    isConnected: () => connected && !disposed,
    onEvent(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ping: (time: number) => request("ping", [time], () => ({ t: time })),
    getConfig: () => request("getConfig", [], () => ({ runtime: "herdr", hostname: "MacBook Pro", build: "v2.4.0", push_enabled: false, capabilities, agent_kinds: ["codex", "claude", "grok", "pi"] })),
    snapshot: () => request("snapshot", [], () => structuredClone(snapshot)),
    paneRead: (paneId: string, lines?: number, format?: string) => request("paneRead", [paneId, lines, format], () => ({ text, hash: hash.toString(16).padStart(64, "0"), truncated: false })),
    sendText: (paneId: string, input: string) => mutation("sendText", [paneId, input], () => { text += input; hash++; return { operation_id: op() }; }),
    sendKeys: (paneId: string, keys: string[], extra?: unknown) => mutation("sendKeys", [paneId, keys, extra]),
    promptAgent: (params: { pane_id?: string; paneId?: string }) => mutation("promptAgent", [params], () => ({ operation_id: op(), pane_id: params.pane_id ?? params.paneId ?? data.PANE, agent_status: "working", outcome: "applied" })),
    listDevices: () => request("listDevices", [], () => ({ devices: structuredClone(deviceList) })),
    revokeDevice: (id: string) => mutation("revokeDevice", [id], () => { const item = deviceList.find((device) => device.device_id === id); if (item) item.revoked_at = FIXED_NOW / 1000; }),
    pushSubscribe: (subscription: unknown) => mutation("pushSubscribe", [subscription]),
    renamePane: (id: string, label: string | null) => mutation("renamePane", [id, label], () => { const pane = snapshot.panes?.find((item) => item.pane_id === id); if (pane) pane.label = label; }),
    renameTab: (id: string, label: string) => mutation("renameTab", [id, label], () => { const tab = snapshot.tabs?.find((item) => item.tab_id === id); if (tab) tab.label = label; }),
    renameWorkspace: (id: string, label: string) => mutation("renameWorkspace", [id, label], () => { const workspace = snapshot.workspaces?.find((item) => item.workspace_id === id); if (workspace) workspace.label = label; }),
    closePane: (id: string) => mutation("closePane", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.pane_id !== id); }),
    closeTab: (id: string) => mutation("closeTab", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.tab_id !== id); }),
    closeWorkspace: (id: string) => mutation("closeWorkspace", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.workspace_id !== id); }),
    createConversation: (params: unknown) => mutation("createConversation", [params], created),
    createTab: (params: unknown) => mutation("createTab", [params], created),
    splitPane: (params: unknown) => mutation("splitPane", [params], created),
    history: (...args: unknown[]) => request("history", args, () => ({ items: [], nextCursor: null, truncated: false })),
    agentTrace: (...args: unknown[]) => request("agentTrace", args, () => ({ items: data.trace(), nextCursor: null, truncated: false })),
    agentTraceDetail: (paneId: string, detailRef: string) => request("agentTraceDetail", [paneId, detailRef], () => ({ detailRef, input: '{"path":"src/app.ts"}', output: data.file().content, truncated: false })),
    agentQuota: () => request("agentQuota", [], data.quotas),
    workspaceOpen: (paneId: string) => request("workspaceOpen", [paneId], data.descriptor),
    workspaceList: (paneId: string, path = "", cursor?: string) => request("workspaceList", [paneId, path, cursor], () => data.directory(path)),
    workspaceRead: (paneId: string, path: string) => request("workspaceRead", [paneId, path], () => data.file(path)),
    gitStatus: (paneId: string) => request("gitStatus", [paneId], data.status),
    gitDiff: (paneId: string, path: string, layer: "staged" | "worktree") => request("gitDiff", [paneId, path, layer], () => data.diff(path, layer)),
    gitBranches: (paneId: string) => request("gitBranches", [paneId], () => ({ items: [
      { name: "main", kind: "local", current: true, head: "1234567890abcdef", upstream: "origin/main" },
      { name: "feature/react", kind: "local", current: false, head: "abcdef", upstream: null },
    ], truncated: false, revision: data.REVISION })),
    workspaceRename: (...args: unknown[]) => mutation("workspaceRename", args),
    workspaceDelete: (...args: unknown[]) => mutation("workspaceDelete", args),
    listWorktrees: (...args: unknown[]) => request("listWorktrees", args, () => ({ worktrees: [
      { path: data.ROOT, branch: "main", label: "Main workspace", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: false, open_workspace_id: "w1" },
      { path: "/work/pairfob-react", branch: "feature/react", label: "React migration", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    ] })),
    createWorktree: (params: unknown) => mutation("createWorktree", [params], () => ({ ...created(), path: "/work/pairfob-react", branch: "feature/react" })),
    openWorktree: (params: unknown) => mutation("openWorktree", [params], () => ({ ...created(), path: "/work/pairfob-react", branch: "feature/react" })),
    resizePane: (params: unknown) => mutation("resizePane", [params], created),
    swapPane: (params: unknown) => mutation("swapPane", [params], created),
    zoomPane: (params: unknown) => mutation("zoomPane", [params], created),
    terminalOpen: (paneId: string, cols: number, rows: number, takeover?: boolean) => mutation("terminalOpen", [paneId, cols, rows, takeover], () => {
      const terminalId = `term_${(++terminalSerial).toString(16).padStart(32, "0")}`;
      terminal = { id: terminalId, cols, rows, sequence: 0n };
      return { operationId: op(), terminalId, paneId, cols, rows, encoding: "ansi" };
    }),
    terminalInput: (...args: unknown[]) => mutation("terminalInput", args),
    terminalResize: (id: string, sequence: number, cols: number, rows: number, ...extra: unknown[]) => mutation("terminalResize", [id, sequence, cols, rows, ...extra], () => {
      if (terminal?.id === id) { terminal.cols = cols; terminal.rows = rows; }
    }),
    terminalScroll: (...args: unknown[]) => mutation("terminalScroll", args),
    terminalClose: (id: string) => mutation("terminalClose", [id], () => { if (terminal?.id === id) terminal = null; }),
    daemonUpdateStatus: () => request("daemonUpdateStatus", [], () => ({ available: true, phase: "idle", target: "", operation_id: "" })),
    daemonUpdate: (target: string) => mutation("daemonUpdate", [target]),
    async switchTransport(target: "auto" | "p2p" | "relay") {
      record("lifecycle", "switchTransport", [target]);
      state.sessionTransport = target === "relay" ? "relay" : "p2p";
      emit({ type: "latency", rttMs: target === "relay" ? 48 : 18, transport: state.sessionTransport });
    },
    reconnectNow: (reason?: string) => { record("lifecycle", "reconnectNow", [reason]); },
    setNetworkAvailable: (available: boolean) => { record("lifecycle", "setNetworkAvailable", [available]); connected = available; },
    close: () => { record("lifecycle", "close"); connected = false; },
  } as unknown as LiveSession;
  return {
    live, emit,
    terminalFrame(text, options = {}) {
      if (!terminal || disposed) return false;
      const sequence = options.sequence ?? String(terminal.sequence + 1n);
      terminal.sequence = BigInt(sequence);
      emit({ type: "terminal_frame", terminalId: terminal.id, terminalFrame: {
        terminalId: terminal.id, sequence, width: options.cols ?? terminal.cols, height: options.rows ?? terminal.rows,
        full: options.full ?? true, index: 0, count: 1, data: new TextEncoder().encode(text),
      } });
      return true;
    },
    setConnected(value) { connected = value; },
    hold(method) { held.add(method); },
    release(method) { held.delete(method); for (const waiter of waiters.get(method) ?? []) waiter.resolve(); waiters.delete(method); },
    failNext(method, code) { failures.set(method, code); },
    dispose() {
      disposed = true;
      terminal = null;
      listeners.clear();
      for (const list of waiters.values()) for (const waiter of list) waiter.reject(new Error("QA scene replaced"));
      waiters.clear();
      held.clear();
    },
  };
}
