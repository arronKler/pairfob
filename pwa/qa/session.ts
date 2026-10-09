import { boardLayoutFixture } from "./board-layout";
import type { SplitPaneInput, ResizePaneInput, SwapPaneInput, ZoomPaneInput } from "../src/lib/operations";
import { ProtocolError } from "../src/lib/protocol/errors";
import { NO_OPERATION_CAPABILITIES } from "../src/lib/operations";
import type { HerdSessionSummary, LiveSession, SessionEvent } from "../src/lib/protocol/session-types";
import type { AgentTraceItem } from "../src/lib/operations";
import { setSessionTransport } from "../src/features/connection/connection-store";
import { FIXED_NOW, record } from "./environment";
import type { FixtureTerminalFrame } from "./types";
import * as data from "./data";
import type { SnapshotWire } from "../src/lib/dashboard";

export type FixtureSession = {
  live: LiveSession;
  emit(event: SessionEvent): void;
  terminalFrame(text: string, options?: FixtureTerminalFrame): boolean;
  /** Frames this session has delivered, its own screen and injected ones alike. */
  terminalFrames(): number;
  setConnected(connected: boolean): void;
  setTrace(items: AgentTraceItem[]): void;
  appendChatTurn(): void;
  hold(method: string): void;
  release(method: string): void;
  failNext(method: string, code: string): void;
  dispose(): void;
};

/** What a scene's computer reports; the baseline fixture when a scene names none. */
export type SessionSource = {
  snapshot?: () => SnapshotWire;
  /** Per-pane screen text; panes it does not know read the shared baseline text. */
  paneText?: (paneId: string) => string | undefined;
  agentKinds?: string[];
  /**
   * What the pane's complete terminal shows, drawn for the grid it was asked
   * for. Like the computer, the fixture sends it once the terminal opens and
   * again after every resize; without one the terminal stays blank until a
   * caller injects a frame.
   */
  terminalScreen?: (cols: number, rows: number) => string;
  /** The Herdr sessions the computer lists; a computer that lists none has no switch. */
  herdSessions?: HerdSessionSummary[];
};

/** Every request is local and logged. Holds/errors allow deliberate async interaction probes. */
export function createSession(source: SessionSource = {}): FixtureSession {
  let connected = true;
  let disposed = false;
  let operation = 0;
  let text = data.PANE_TEXT;
  let hash = 1;
  let terminalSerial = 0;
  let terminal: { id: string; cols: number; rows: number; sequence: bigint } | null = null;
  let terminalFrames = 0;
  const listeners = new Set<(event: SessionEvent) => void>();
  const held = new Set<string>();
  const waiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  const failures = new Map<string, string>();
  const snapshot = (source.snapshot ?? data.snapshot)();
  const board = boardLayoutFixture(snapshot);
  const deviceList = data.devices();
  let trace = data.trace();
  let appendedTurns = 0;
  const capabilities = Object.fromEntries(Object.keys(NO_OPERATION_CAPABILITIES).map((key) => [key, true]));
  const emit = (event: SessionEvent) => { for (const listener of listeners) listener(event); };
  const op = () => `op_qa_${String(++operation).padStart(12, "0")}`;
  const created = () => ({ operation_id: op(), workspace_id: "w1", tab_id: "w1:t1", pane_id: data.PANE, outcome: "applied" });
  const sendFrame = (text: string, options: FixtureTerminalFrame = {}): boolean => {
    if (!terminal || disposed) return false;
    const sequence = options.sequence ?? String(terminal.sequence + 1n);
    terminal.sequence = BigInt(sequence);
    terminalFrames++;
    emit({ type: "terminal_frame", terminalId: terminal.id, terminalFrame: {
      terminalId: terminal.id, sequence, width: options.cols ?? terminal.cols, height: options.rows ?? terminal.rows,
      full: options.full ?? true, index: 0, count: 1, data: new TextEncoder().encode(text),
    } });
    return true;
  };
  // On the next task, once the caller holds the reply that names this terminal:
  // a frame for a terminal the page has not adopted yet is dropped.
  const sendScreen = (id: string): void => {
    const screen = source.terminalScreen;
    if (!screen) return;
    setTimeout(() => {
      if (terminal?.id === id) sendFrame(screen(terminal.cols, terminal.rows));
    }, 0);
  };
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
  // A file deleted or renamed from its menu leaves the listing, as on a real computer, so what the list does next can be walked.
  const deletedFiles = new Set<string>();
  const renamedFiles = new Map<string, string>();
  const listed = (page: ReturnType<typeof data.directory>): ReturnType<typeof data.directory> => ({
    ...page,
    entries: page.entries.filter((entry) => !deletedFiles.has(entry.path)).map((entry) => {
      const name = renamedFiles.get(entry.path);
      return name ? { ...entry, name, path: `${entry.path.slice(0, entry.path.length - entry.name.length)}${name}` } : entry;
    }),
  });
  const live = {
    isConnected: () => connected && !disposed,
    onEvent(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ping: (time: number) => request("ping", [time], () => ({ t: time })),
    getConfig: () => request("getConfig", [], () => ({ runtime: "herdr", hostname: "MacBook Pro", build: "v2.4.0", push_enabled: false, capabilities, agent_kinds: source.agentKinds ?? ["codex", "claude", "grok", "pi"] })),
    snapshot: () => request("snapshot", [], () => structuredClone(snapshot)),
    paneRead: (paneId: string, lines?: number, format?: string) => request("paneRead", [paneId, lines, format], () => ({ text: source.paneText?.(paneId) ?? text, hash: hash.toString(16).padStart(64, "0"), truncated: false })),
    sendText: (paneId: string, input: string) => mutation("sendText", [paneId, input], () => { text += input; hash++; return { operation_id: op() }; }),
    sendKeys: (paneId: string, keys: string[], extra?: unknown) => mutation("sendKeys", [paneId, keys, extra]),
    promptAgent: (params: { pane_id?: string; paneId?: string }) => mutation("promptAgent", [params], () => ({ operation_id: op(), pane_id: params.pane_id ?? params.paneId ?? data.PANE, agent_status: "unknown", outcome: "applied" })),
    listDevices: () => request("listDevices", [], () => ({ devices: structuredClone(deviceList) })),
    revokeDevice: (id: string) => mutation("revokeDevice", [id], () => { const item = deviceList.find((device) => device.device_id === id); if (item) item.revoked_at = FIXED_NOW / 1000; }),
    pushSubscribe: (subscription: unknown) => mutation("pushSubscribe", [subscription]),
    renamePane: (id: string, label: string | null) => mutation("renamePane", [id, label], () => { const pane = snapshot.panes?.find((item) => item.pane_id === id); if (pane) pane.label = label; }),
    renameTab: (id: string, label: string) => mutation("renameTab", [id, label], () => { const tab = snapshot.tabs?.find((item) => item.tab_id === id); if (tab) tab.label = label; }),
    renameWorkspace: (id: string, label: string) => mutation("renameWorkspace", [id, label], () => { const workspace = snapshot.workspaces?.find((item) => item.workspace_id === id); if (workspace) workspace.label = label; }),
    closePane: (id: string) => mutation("closePane", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.pane_id !== id); board.close(id); }),
    closeTab: (id: string) => mutation("closeTab", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.tab_id !== id); }),
    closeWorkspace: (id: string) => mutation("closeWorkspace", [id], () => { snapshot.panes = snapshot.panes?.filter((pane) => pane.workspace_id !== id); }),
    createConversation: (params: unknown) => mutation("createConversation", [params], created),
    createTab: (params: unknown) => mutation("createTab", [params], created),
    splitPane: (params: SplitPaneInput) => mutation("splitPane", [params], () => ({ ...created(), ...board.split(params) })),
    history: (...args: unknown[]) => request("history", args, () => ({ items: [], nextCursor: null, truncated: false })),
    agentTrace: (...args: unknown[]) => request("agentTrace", args, () => ({ items: structuredClone(trace), nextCursor: null, truncated: false })),
    agentTraceDetail: (paneId: string, detailRef: string) => request("agentTraceDetail", [paneId, detailRef], () => {
      const item = trace.find((entry) => entry.detailRef === detailRef);
      return { detailRef, input: item?.input, output: item?.output, truncated: false };
    }),
    agentInspect: (paneId: string) => request("agentInspect", [paneId], () => ({ status: "idle" as const, manifest_source: "builtin", manifest_version: "1.2.0", matched_rule: "ready-prompt", screen_detection_skipped: false, rules: [{ id: "ready-prompt", state: "idle" as const, matched: true }] })),
    agentQuota: () => request("agentQuota", [], data.quotas),
    workspaceOpen: (paneId: string) => request("workspaceOpen", [paneId], data.descriptor),
    workspaceList: (paneId: string, path = "", cursor?: string) => request("workspaceList", [paneId, path, cursor], () => listed(data.directory(path))),
    workspaceRead: (paneId: string, path: string) => request("workspaceRead", [paneId, path], () => data.file(path)),
    workspaceMediaOpen: (paneId: string, path: string) => request("workspaceMediaOpen", [paneId, path], () => data.mediaOpen(path)),
    workspaceMediaRead: (handle: string, offset: number, length: number) => request("workspaceMediaRead", [handle, offset, length], () => data.mediaChunk(handle, offset, length)),
    workspaceMediaClose: (handle: string) => request("workspaceMediaClose", [handle], () => ({ handle, closed: true as const })),
    gitStatus: (paneId: string) => request("gitStatus", [paneId], data.status),
    gitDiff: (paneId: string, path: string, layer: "staged" | "worktree") => request("gitDiff", [paneId, path, layer], () => data.diff(path, layer)),
    gitBranches: (paneId: string) => request("gitBranches", [paneId], () => ({ items: [
      { name: "main", kind: "local", current: true, head: "1234567890abcdef", upstream: "origin/main" },
      { name: "feature/react", kind: "local", current: false, head: "abcdef", upstream: null },
    ], truncated: false, revision: data.REVISION })),
    workspaceRename: (...args: unknown[]) => mutation("workspaceRename", args, () => { renamedFiles.set(String(args[2]), String(args[3])); return { operation_id: op(), outcome: "applied" }; }),
    workspaceDelete: (...args: unknown[]) => mutation("workspaceDelete", args, () => { deletedFiles.add(String(args[2])); return { operation_id: op(), outcome: "applied" }; }),
    listWorktrees: (...args: unknown[]) => request("listWorktrees", args, () => ({ worktrees: [
      { path: data.ROOT, branch: "main", label: "Main workspace", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: false, open_workspace_id: "w1" },
      { path: "/work/pairfob-react", branch: "feature/react", label: "React migration", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    ] })),
    createWorktree: (params: unknown) => mutation("createWorktree", [params], () => ({ ...created(), path: "/work/pairfob-react", branch: "feature/react" })),
    openWorktree: (params: unknown) => mutation("openWorktree", [params], () => ({ ...created(), path: "/work/pairfob-react", branch: "feature/react" })),
    resizePane: (params: ResizePaneInput) => mutation("resizePane", [params], () => { board.resize(params); return created(); }),
    swapPane: (params: SwapPaneInput) => mutation("swapPane", [params], () => { board.swap(params); return created(); }),
    zoomPane: (params: ZoomPaneInput) => mutation("zoomPane", [params], () => { board.zoom(params); return created(); }),
    terminalOpen: (paneId: string, cols: number, rows: number, takeover?: boolean) => mutation("terminalOpen", [paneId, cols, rows, takeover], () => {
      const terminalId = `term_${(++terminalSerial).toString(16).padStart(32, "0")}`;
      terminal = { id: terminalId, cols, rows, sequence: 0n };
      sendScreen(terminalId);
      return { operationId: op(), terminalId, paneId, cols, rows, encoding: "ansi" };
    }),
    terminalInput: (...args: unknown[]) => mutation("terminalInput", args),
    terminalResize: (id: string, sequence: number, cols: number, rows: number, ...extra: unknown[]) => mutation("terminalResize", [id, sequence, cols, rows, ...extra], () => {
      if (terminal?.id !== id) return;
      const changed = terminal.cols !== cols || terminal.rows !== rows;
      terminal.cols = cols;
      terminal.rows = rows;
      if (changed) sendScreen(id);
    }),
    terminalScroll: (...args: unknown[]) => mutation("terminalScroll", args),
    terminalClose: (id: string) => mutation("terminalClose", [id], () => { if (terminal?.id === id) terminal = null; }),
    ...(source.herdSessions ? {
      listHerdSessions: () => request("listHerdSessions", [], () => structuredClone(source.herdSessions)),
      herdSession: () => null,
    } : {}),
    daemonUpdateStatus: () => request("daemonUpdateStatus", [], () => ({ available: true, phase: "idle", target: "", operation_id: "" })),
    daemonUpdate: (target: string) => mutation("daemonUpdate", [target]),
    async switchTransport(target: "auto" | "p2p" | "relay") {
      record("lifecycle", "switchTransport", [target]);
      setSessionTransport(target === "relay" ? "relay" : "p2p");
      emit({ type: "latency", rttMs: target === "relay" ? 48 : 18, transport: target === "relay" ? "relay" : "p2p" });
    },
    reconnectNow: (reason?: string) => { record("lifecycle", "reconnectNow", [reason]); },
    setNetworkAvailable: (available: boolean) => { record("lifecycle", "setNetworkAvailable", [available]); connected = available; },
    close: () => { record("lifecycle", "close"); connected = false; },
  } as unknown as LiveSession;
  return {
    live, emit,
    terminalFrame: sendFrame,
    terminalFrames: () => terminalFrames,
    setConnected(value) { connected = value; },
    setTrace(items) { trace = structuredClone(items); appendedTurns = 0; },
    appendChatTurn() {
      if (trace.length >= 200) throw new Error("QA chat trace reached its 200-item bound");
      const id = ++appendedTurns;
      trace.push(
        { type: "user", text: `QA appended turn ${id}` },
        { type: "assistant", text: `QA appended response ${id}` },
      );
    },
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
