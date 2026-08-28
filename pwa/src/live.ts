import { parseAnsi } from "./lib/ansi";
import { askConfirm, askText } from "./lib/dom";
import {
  agentTitle,
  canPromptAgent,
  choosePane,
  herdSignature,
  type SnapshotWire as Snapshot,
} from "./lib/dashboard";
import { credentialIsBurned, phaseAfterComputers, sortComputers } from "./lib/computer-catalog";
import { deleteCredential, loadCatalog, rememberLastUsed, saveCredential } from "./lib/credentials";
import {
  askAgentPrompt,
  askCreateConversation,
  askCreateTab,
  askLayout,
  askSplitPane,
  askWorktree,
  showWorktrees,
} from "./lib/operation-ui";
import { showHistory } from "./lib/history-ui";
import {
  NO_OPERATION_CAPABILITIES,
  OPERATION_INPUT_LIMITS,
  openWorktreeFromSummary,
  parseRuntimeOperationsConfig,
  worktreeScope,
  type ListWorktreesInput,
  type WorktreeDraft,
} from "./lib/operations";
import { ProtocolError, sessionOverWS, type PairResult, type SessionEvent } from "./lib/protocol/client";
import { createLivePolling } from "./live-polling";
import { resetLiveConnectionState } from "./live-state";
import { nextTouchedAt } from "./lib/ranking";
import { type NoticeScope } from "./lib/notice-scope";
import { reconcileAmbiguousMutation, reportMutationError } from "./mutations";
import { openPendingNotification } from "./notifications";
import { panePollDelayMs, pokeRefreshAction, shouldPullStatus } from "./poll";
import { clearAgentTraceCache, forgetAgentTrace } from "./lib/agent-trace-cache";
import { render } from "./paint";
import {
  FRIENDLY_ERROR,
  acknowledgePaneCompletion,
  captureNoticeScope,
  clearNotice,
  clearNoticeForScope,
  loadPaneTouched,
  loadCompletionSeen,
  markPaneSubmitted,
  messageOf,
  noticeScopeIsCurrent,
  sessionEventNotice,
  loadPaneTermModes,
  paneTermMode,
  rememberPane,
  replaceAgentsFromSnapshot,
  resetPaneView,
  savePaneTouched,
  selectedAgent,
  showError,
  showStatus,
  state,
  wsURL,
} from "./state";
import { isDesk } from "./viewport";
import { composeField, dropQueuedKeys, paneReadLines, patchChromeTitle, patchSessionScreen, preserveCompose } from "./ui/session-view";
import { canEnterAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace } from "./ui/agent-chat";
import { disposeFullTerminal, handleFullTerminalEvent, leaveFullTerminal } from "./ui/full-terminal";
import { guidedScrollController } from "./ui/session/guided-scroll";
import { track } from "./lib/telemetry";

export { enablePush, openSettings, refreshSettings } from "./live-settings";

const livePolling = createLivePolling({
  canRun: () => state.networkOnline && document.visibilityState === "visible" && state.phase === "live" && state.live?.isConnected() === true,
  canReadPane: () => state.screen === "pane" && Boolean(state.paneId) && !state.fullTerminal,
  paneDelayMs: () => panePollDelayMs(state.agentChat, selectedAgent()?.status === "working"),
  refreshSnapshot: () => refreshSnapshot(),
  refreshPane: () => refreshPaneRead(),
});
let herdConfigRequest = 0;

export async function reloadComputers(): Promise<void> {
  const catalog = await loadCatalog(location.origin);
  state.lastUsedDaemonId = catalog.lastUsedDaemonId;
  state.computers = sortComputers(catalog.credentials, catalog.lastUsedDaemonId);
}

export function clearLiveConnection(): void {
  stopPolling();
  guidedScrollController.dispose();
  disposeFullTerminal();
  state.live?.close();
  resetLiveConnectionState();
}

export async function landAfterDisconnect(opts: {
  daemonId?: string | null;
  code?: string;
  error?: unknown;
  silent?: boolean;
}): Promise<void> {
  const code = opts.code || (opts.error instanceof ProtocolError ? opts.error.code : "");
  clearLiveConnection();
  if (opts.daemonId && credentialIsBurned(code)) {
    await deleteCredential(opts.daemonId).catch(() => undefined);
    if (state.credential?.daemonId === opts.daemonId) state.credential = null;
  }
  await reloadComputers().catch(() => undefined);
  state.addingComputer = false;
  state.screen = "home";
  state.phase = phaseAfterComputers(state.computers.length);
  if (!state.computers.length) state.credential = null;
  if (!opts.silent) {
    const burned = credentialIsBurned(code) && (code === "revoked" || code === "unpaired");
    if (opts.error) showError(burned ? FRIENDLY_ERROR.revoked : messageOf(opts.error));
    else if (code) showError(burned ? FRIENDLY_ERROR.revoked : sessionEventNotice({ type: "terminal", code }));
  }
  track("pwa_disconnect", { result: code || "disconnected" });
  render();
}

export async function establish(pair: PairResult): Promise<void> {
  stopPolling();
  clearAgentTraceCache();
  disposeFullTerminal();
  state.phase = "resuming";
  state.credential = pair;
  state.addingComputer = false;
  state.agents = [];
  state.runtimeAgentStatuses = {};
  state.completionSeen = {};
  state.paneId = "";
  state.herdHost = pair.hostname || "";
  state.runtimeKind = "";
  state.deviceList = [];
  state.pushSubscribed = null;
  state.lastHerdSig = "";
  state.snapshotAt = 0;
  resetPaneView();
  render();
  state.live?.close();
  if (state.live) state.live = null;
  state.paneTouched = loadPaneTouched();
  state.paneTermModes = loadPaneTermModes();
  await rememberLastUsed(pair.daemonId).catch(() => undefined);
  state.lastUsedDaemonId = pair.daemonId;
  state.live = await sessionOverWS(wsURL({ daemonId: pair.daemonId }), pair);
  const seen = { ...pair, lastSeen: Math.floor(Date.now() / 1000) };
  state.credential = seen;
  await saveCredential(seen).catch(() => undefined);
  state.live.onEvent(onSessionEvent);
  state.live.setNetworkAvailable(state.networkOnline);
  state.completionSeen = loadCompletionSeen();
  state.phase = "live";
  state.screen = "home";
  track("pwa_live");
  if (document.visibilityState === "hidden") showStatus("已连上。回到这个页面后会读取会话。");
  else clearNotice();
  render();
  startPolling();
  await refreshRuntimeState();
  await reloadComputers().catch(() => undefined);
}

function onSessionEvent(event: SessionEvent): void {
  if (guidedScrollController.handleEvent(event)) return;
  if (handleFullTerminalEvent(event) && (event.type === "terminal_frame" || event.type === "terminal_closed")) return;
  if (event.type === "poke" && document.visibilityState === "visible") {
    const action = pokeRefreshAction(state.screen, state.paneId, event.paneId, event.reason);
    if (action === "runtime") void refreshRuntimeState();
    else if (action === "snapshot") void refreshSnapshot();
    else if (action === "paneread") {
      livePolling.wakePane();
      if (state.agentChat && shouldPullStatus(true, Date.now(), state.snapshotAt)) void refreshSnapshot();
    }
    return;
  }
  if (event.type === "connected") {
    clearNotice();
    startPolling();
    render();
    if (document.visibilityState === "visible") void refreshRuntimeState();
  } else if (event.type === "disconnected" || event.type === "reconnecting") {
    stopPolling();
    showStatus(sessionEventNotice(event), true);
    render();
  } else if (event.type === "terminal") {
    void handleTerminal(event);
  }
}

export async function refreshRuntimeState(): Promise<void> {
  const session = state.live;
  const updated = await refreshHerdConfig();
  if (!updated || state.live !== session) return;
  if (state.runtimeKind === "herdr" && state.notice?.text === FRIENDLY_ERROR.herdr_offline) clearNotice();
  render();
  await refreshFromSession();
}

async function handleTerminal(event: SessionEvent): Promise<void> {
  await landAfterDisconnect({ daemonId: state.credential?.daemonId, code: event.code });
}

export async function refreshHerdConfig(): Promise<boolean> {
  const session = state.live;
  const request = ++herdConfigRequest;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  state.agentKinds = [];
  if (!session) return false;
  try {
    const config = await session.getConfig();
    const operations = parseRuntimeOperationsConfig(config);
    if (request !== herdConfigRequest || state.live !== session) return false;
    const hostname = typeof config.hostname === "string" ? config.hostname : "";
    state.herdHost = hostname;
    state.runtimeKind = typeof config.runtime === "string" ? config.runtime : "";
    state.pushEnabled = config.push_enabled === true;
    state.operationCapabilities = operations.capabilities;
    state.agentKinds = operations.agentKinds;
    if (state.credential && hostname && state.credential.hostname !== hostname) {
      const updated = { ...state.credential, hostname, lastSeen: Math.floor(Date.now() / 1000) };
      state.credential = updated;
      await saveCredential(updated).catch(() => undefined);
      await reloadComputers().catch(() => undefined);
    }
    return true;
  } catch {
    if (request === herdConfigRequest && state.live === session) {
      state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
      state.agentKinds = [];
      return true;
    }
    return false;
  }
}

export async function openPane(paneId: string): Promise<void> {
  dropQueuedKeys();
  guidedScrollController.dispose();
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  rememberPane(paneId);
  state.paneId = paneId;
  resetPaneView();
  restoreAgentTrace(paneId);
  clearNotice();
  state.screen = "pane";
  const mode = paneTermMode(paneId);
  const agent = state.agents.find((item) => item.paneId === paneId);
  state.fullTerminal = mode === "full";
  state.agentChat = mode === "agent" && canEnterAgentChat(agent);
  render();
  await refreshPane();
}

function abandonOpenPane(message: string): void {
  disposeFullTerminal();
  state.screen = "home";
  resetPaneView();
  showError(message);
  render();
}

export async function refreshSnapshot(): Promise<void> {
  if (!state.live || !state.live.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  if (state.refreshBusy) {
    state.snapshotPending = true;
    return;
  }
  state.refreshBusy = true;
  try {
    const snapshot = (await state.live.snapshot()) as Snapshot;
    state.snapshotAt = Date.now();
    const previous = replaceAgentsFromSnapshot(snapshot);
    state.paneTouched = nextTouchedAt(previous, state.agents, state.paneTouched);
    savePaneTouched();
    const nextSig = herdSignature(state.agents);
    const unchanged = nextSig === state.lastHerdSig;
    state.lastHerdSig = nextSig;
    if (await openPendingNotification(openPane)) return;
    if (state.screen === "pane") {
      state.paneId = choosePane(state.paneId, state.agents);
      if (!state.paneId) {
        abandonOpenPane("这个会话已经不在了。");
        return;
      }
      if (state.agentChat) {
        if (!patchAgentChat()) render();
        return;
      }
      if (unchanged) {
        patchChromeTitle();
        if (isDesk()) render();
        return;
      }
      patchChromeTitle();
      if (isDesk()) render();
      return;
    }
    if (state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
      state.paneId = "";
      state.paneText = "";
      state.paneHash = "";
    }
    if ((state.screen === "home" || state.screen === "settings" || state.screen === "computers") && unchanged) return;
    render();
  } catch (error) {
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) showError(messageOf(error));
    render();
  } finally {
    state.refreshBusy = false;
    if (state.snapshotPending) {
      state.snapshotPending = false;
      void refreshSnapshot();
    }
  }
}

export async function refreshPaneRead(): Promise<void> {
  if (!state.live || !state.paneId || !state.live.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  if (state.screen !== "pane" || state.fullTerminal) return;
  if (state.agentChat) {
    const changed = await refreshAgentTrace();
    if (changed && shouldPullStatus(true, Date.now(), state.snapshotAt)) void refreshSnapshot();
    return;
  }
  // A burst of key taps must not silently drop the read that shows their result.
  if (state.paneReadBusy) {
    state.paneReadPending = true;
    return;
  }
  const paneId = state.paneId;
  state.paneReadBusy = true;
  try {
    const read = await state.live.paneRead(paneId, paneReadLines());
    if (state.paneId !== paneId || state.screen !== "pane" || state.fullTerminal) return;
    const nextText = typeof read?.text === "string" ? read.text : "";
    const nextHash = typeof read?.hash === "string" ? read.hash : "";
    const same = nextHash !== "" && nextHash === state.paneHash && nextText === state.paneText;
    state.paneText = nextText;
    state.paneHash = nextHash;
    const acknowledged = acknowledgePaneCompletion(paneId);
    if (shouldPullStatus(!same, Date.now(), state.snapshotAt)) void refreshSnapshot();
    const keep = preserveCompose();
    if (same) {
      patchChromeTitle();
      // An idle screen owes the desk rail one repaint only when this read
      // acknowledged a completion. Rendering every poll would remount the
      // pane and wipe an in-progress text selection over nothing.
      if (acknowledged && isDesk() && !keep) render();
      return;
    }
    if (keep && patchSessionScreen()) return;
    if (keep && composeField()) return;
    if (!patchSessionScreen()) render();
  } catch (error) {
    const code = error instanceof ProtocolError ? error.code : "";
    if (code === "pane_not_found") {
      state.paneText = "";
      state.paneHash = "";
      await refreshSnapshot();
      if (state.screen === "pane" && state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
        abandonOpenPane("这个会话已经不在了。");
      }
      return;
    }
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) {
      showError(messageOf(error));
      render();
    }
  } finally {
    state.paneReadBusy = false;
    if (state.paneReadPending) {
      state.paneReadPending = false;
      void refreshPaneRead();
    }
  }
}

export async function refreshFromSession(): Promise<void> {
  await Promise.all([
    refreshSnapshot(),
    state.screen === "pane" && state.paneId && !state.fullTerminal ? refreshPaneRead() : Promise.resolve(),
  ]);
}

export async function refreshPane(): Promise<void> {
  if (!state.live || !state.paneId || !state.live.isConnected()) {
    state.paneText = "";
    state.paneHash = "";
    render();
    return;
  }
  await refreshPaneRead();
}

export function startPolling(): void {
  livePolling.start();
}

export function stopPolling(): void {
  livePolling.stop();
}

export async function revokeSelf(): Promise<void> {
  const session = state.live;
  if (
    !session ||
    !state.credential ||
    !(await askConfirm("解除这台手机的配对后会立即断开并删除本地凭证，以后需要重新配对。", "解除这台手机的配对"))
  )
    return;
  try {
    await session.revokeSelf(state.credential.deviceId);
    const daemonId = state.credential.daemonId;
    await landAfterDisconnect({ daemonId, code: "revoked", silent: true });
    showStatus("已解除这台手机的配对并删除本地凭证。");
  } catch (error) {
    await reportMutationError(session, error);
  }
  render();
}

type HerdOperationOptions<T> = {
  after?: (result: T) => Promise<void>;
  reconcileWorktrees?: ListWorktreesInput;
  noticeScope?: NoticeScope;
};

async function runHerdOperation<T>(
  pending: string,
  success: string,
  action: () => Promise<T>,
  options: HerdOperationOptions<T> = {},
): Promise<void> {
  if (state.operationBusy || !state.live?.isConnected()) return;
  const session = state.live;
  const { after, reconcileWorktrees, noticeScope } = options;
  state.operationBusy = true;
  showStatus(pending, true, noticeScope);
  render();
  try {
    const result = await action();
    if (after) await after(result);
    else await refreshFromSession();
    if (!noticeScope || (state.live === session && noticeScopeIsCurrent(noticeScope))) showStatus(success, false, noticeScope);
    else clearNoticeForScope(noticeScope);
  } catch (error) {
    await reconcileAmbiguousMutation(session, error, reconcileWorktrees);
    if (!noticeScope || (state.live === session && noticeScopeIsCurrent(noticeScope))) showError(messageOf(error), noticeScope);
    else clearNoticeForScope(noticeScope);
  } finally {
    state.operationBusy = false;
    render();
  }
}

async function selectCreatedPane(result: { pane_id?: string }): Promise<void> {
  const paneId = typeof result.pane_id === "string" && result.pane_id ? result.pane_id : "";
  // Refresh first so the switch below sees the new pane in the snapshot, then
  // reuse the normal open path: it applies the pane's remembered / default
  // view mode and tears down a live full-terminal bridge instead of leaking it.
  await refreshFromSession();
  if (paneId) await openPane(paneId);
}

export async function startNewConversation(): Promise<void> {
  const session = state.live;
  if (!session || !state.operationCapabilities.create_conversation) return;
  const defaults = selectedAgent()?.cwd || state.agents.find((agent) => agent.cwd)?.cwd || "";
  const input = await askCreateConversation(state.agentKinds, defaults);
  if (!input || state.live !== session) return;
  await runHerdOperation("正在新建会话…", "会话已创建。", () => session.createConversation(input), {
    after: selectCreatedPane,
  });
}

export async function createSelectedTab(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !selected?.workspaceId || !state.operationCapabilities.create_tab) return;
  const input = await askCreateTab(selected.cwd);
  if (!input || state.live !== session) return;
  await runHerdOperation(
    "正在新建标签页…",
    "标签页已创建。",
    () => session.createTab({ workspace_id: selected.workspaceId!, ...input }),
    { after: selectCreatedPane },
  );
}

export async function splitSelectedPane(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !selected || !state.operationCapabilities.split_pane) return;
  const input = await askSplitPane(selected.cwd);
  if (!input || state.live !== session) return;
  await runHerdOperation(
    "正在创建分屏…",
    "分屏已创建。",
    () => session.splitPane({ pane_id: selected.paneId, ...input }),
    { after: selectCreatedPane },
  );
}

export async function promptSelectedAgent(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !canPromptAgent(selected) || !state.operationCapabilities.prompt_agent) return;
  const text = await askAgentPrompt();
  if (!text || state.live !== session) return;
  const noticeScope = captureNoticeScope();
  await runHerdOperation(
    "正在发送任务…",
    "任务已发送。",
    () => session.promptAgent({ pane_id: selected.paneId, text }),
    {
      noticeScope,
      after: async () => {
        markPaneSubmitted(selected.paneId);
        if (state.live === session && noticeScopeIsCurrent(noticeScope)) await refreshPane();
      },
    },
  );
}

export async function openSelectedTerminalHistory(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !selected || !state.operationCapabilities.history) return;
  const load = async (cursor: string | null) => {
    try {
      return await session.history(selected.paneId, cursor, 50);
    } catch (error) {
      if (error instanceof ProtocolError) throw new ProtocolError(error.code, messageOf(error));
      throw error;
    }
  };
  await showHistory({ terminal: load });
}

function selectedWorktreeDefaults(): WorktreeDraft | null {
  const selected = selectedAgent();
  return selected ? worktreeScope(selected.workspaceId, selected.cwd) : null;
}

export async function listSelectedWorktrees(): Promise<void> {
  const session = state.live;
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !state.operationCapabilities.list_worktrees) return;
  await showWorktrees(
    () => session.listWorktrees(defaults),
    state.operationCapabilities.open_worktree
      ? async (item) => {
          try {
            const input = openWorktreeFromSummary(defaults, item);
            if (!input) throw new Error("这个 Worktree 没有可打开的路径或分支。");
            const result = await session.openWorktree(input);
            await selectCreatedPane(result);
            showStatus("Worktree 已打开。");
            render();
          } catch (error) {
            await reconcileAmbiguousMutation(session, error, defaults);
            if (error instanceof ProtocolError) throw new ProtocolError(error.code, messageOf(error));
            throw error;
          }
        }
      : undefined,
  );
}

export async function createSelectedWorktree(): Promise<void> {
  const session = state.live;
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !state.operationCapabilities.create_worktree) return;
  const input = await askWorktree("create", defaults);
  if (!input || state.live !== session) return;
  await runHerdOperation("正在新建 Worktree…", "Worktree 已创建。", () => session.createWorktree(input), {
    after: selectCreatedPane,
    reconcileWorktrees: defaults,
  });
}

export async function openSelectedWorktree(): Promise<void> {
  const session = state.live;
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !state.operationCapabilities.open_worktree) return;
  const input = await askWorktree("open", defaults);
  if (!input || state.live !== session) return;
  await runHerdOperation("正在打开 Worktree…", "Worktree 已打开。", () => session.openWorktree(input), {
    after: selectCreatedPane,
    reconcileWorktrees: defaults,
  });
}

export async function layoutSelectedPane(kind: "resize" | "swap" | "zoom"): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  const allowed =
    kind === "resize"
      ? state.operationCapabilities.resize_pane
      : kind === "swap"
        ? state.operationCapabilities.swap_pane
        : state.operationCapabilities.zoom_pane;
  if (!session || !selected || !allowed) return;
  if (kind === "zoom") {
    await runHerdOperation("正在铺满这一格…", "已切换全屏。", () =>
      session.zoomPane({ pane_id: selected.paneId, mode: "toggle" }),
    );
    return;
  }
  const choice = await askLayout(kind);
  if (!choice || state.live !== session) return;
  if (choice.kind === "resize") {
    await runHerdOperation("正在调整这一格…", "这一格已调整。", () =>
      session.resizePane({ pane_id: selected.paneId, direction: choice.direction, amount: choice.amount }),
    );
  } else {
    await runHerdOperation("正在对调分屏…", "分屏已对调。", () =>
      session.swapPane({ pane_id: selected.paneId, direction: choice.direction }),
    );
  }
}

export async function renamePane(): Promise<void> {
  const session = state.live;
  if (!session || !state.paneId) return;
  const label = await askText(
    "修改会话名（留空恢复自动名称）",
    selectedAgent()?.paneLabel || "",
    OPERATION_INPUT_LIMITS.label,
    "会话名",
  );
  if (label === null) return;
  try {
    await session.renamePane(state.paneId, label.trim() || null);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function renameTab(): Promise<void> {
  const selected = selectedAgent();
  const session = state.live;
  if (!session || !selected?.tabId) return;
  const label = await askText("修改标签页名", selected.tabLabel || "", OPERATION_INPUT_LIMITS.label, "标签页名");
  if (label === null) return;
  const normalized = label.trim();
  if (!normalized) {
    showError("标签页名不能为空。");
    render();
    return;
  }
  try {
    await session.renameTab(selected.tabId, normalized);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function renameWorkspace(): Promise<void> {
  const selected = selectedAgent();
  const session = state.live;
  if (!session || !selected?.workspaceId) return;
  const label = await askText("修改工作区名", selected.workspaceLabel, OPERATION_INPUT_LIMITS.label, "工作区名");
  if (label === null) return;
  const normalized = label.trim();
  if (!normalized) {
    showError("工作区名不能为空。");
    render();
    return;
  }
  try {
    await session.renameWorkspace(selected.workspaceId, normalized);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function closePane(): Promise<void> {
  const session = state.live;
  if (
    !session ||
    !state.paneId ||
    !(await askConfirm(
      `关闭「${selectedAgent() ? agentTitle(selectedAgent()!) : "这个会话"}」会结束里面的进程，而且不能撤销。`,
      "关闭这个会话",
    ))
  )
    return;
  try {
    const paneId = state.paneId;
    await session.closePane(state.paneId);
    forgetAgentTrace(paneId);
    state.paneId = "";
    resetPaneView();
    state.screen = "home";
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function closeTab(): Promise<void> {
  const selected = selectedAgent();
  const session = state.live;
  if (!session || !selected?.tabId) return;
  const label = selected.tabLabel || selected.tabId;
  if (!(await askConfirm(`关闭整个标签页“${label}”会结束里面所有会话，而且不能撤销。`, "关闭整个标签页"))) return;
  try {
    await session.closeTab(selected.tabId);
    clearAgentTraceCache();
    state.paneId = "";
    resetPaneView();
    state.screen = "home";
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function copyScreenText(): Promise<void> {
  const text = parseAnsi(state.paneText)
    .map((line) => line.text)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showStatus("已复制当前画面。");
  } catch {
    showError("浏览器没有允许复制。");
  }
  render();
}
