import { parseAnsi } from "./lib/ansi";
import { agentTitle, canPromptAgent, tabSiblings, workspaceSiblings } from "./lib/dashboard";
import {
  beginDiffNoteSend,
  composeDiffNotesPrompt,
  diffNoteScope,
  diffNoteSendOpen,
  diffNotesFor,
  endDiffNoteSend,
  removeDiffNotes,
} from "./lib/diff-notes";
import { askConfirm, askText } from "./lib/dom";
import { t } from "./lib/i18n";
import { displayDeviceLabel } from "./lib/ui-model";
import { clearAgentTraceCache, forgetAgentTrace } from "./lib/agent-trace-cache";
import { type NoticeScope } from "./lib/notice-scope";
import {
  OPERATION_INPUT_LIMITS,
  openWorktreeFromSummary,
  worktreeScope,
  type ListWorktreesInput,
  type WorktreeDraft,
} from "./lib/operations";
import { type GitLayer } from "./lib/workspace";
import {
  askAgentPrompt,
  askCreateConversation,
  askCreateTab,
  askLayout,
  askSplitPane,
  askWorktree,
  showWorktrees,
} from "./lib/operation-ui";
import { ProtocolError, type DeviceSummary, type LiveSession } from "./lib/protocol/client";
import { type AgentCard } from "./lib/ranking";
import { startWorktreeJob, type WorktreeJobDriver } from "./lib/worktree-jobs";
import { acquirePromptLock, applyComposeDraft, currentViewIncarnation, parkComposeView, releasePromptLock } from "./compose-drafts";
import { landAfterDisconnect, openPane, openPaneWithOwner, refreshFromSession, refreshPane } from "./live";
import { reconcileAmbiguousMutation } from "./mutations";
import { render } from "./paint";
import { promptLockHeld } from "./state-drafts";
import {
  captureNoticeScope,
  clearNoticeForScope,
  markPaneSubmitted,
  messageOf,
  noticeScopeIsCurrent,
  leavePaneScreen,
  resetPaneView,
  selectedAgent,
  showError,
  showStatus,
  state,
} from "./state";
import { disposeFullTerminal, leaveFullTerminalWithTransition } from "./ui/full-terminal";
import { dropQueuedKeys } from "./ui/session-view";

export async function revokeSelf(): Promise<void> {
  const session = state.live;
  const credential = state.credential;
  if (!session || !credential) return;
  const owner = operationOwner(session);
  if (!(await askConfirm(t("live.unpairAsk"), t("settings.unpair"))) || !ownsOperationView(owner)) return;
  try {
    await session.revokeDevice(credential.deviceId);
    if (!ownsOperationView(owner)) return;
    await landAfterDisconnect({ daemonId: credential.daemonId, code: "revoked", silent: true });
    showStatus(t("live.unpaired"));
  } catch (error) {
    await reportOwnedError(owner, error);
  }
  if (ownsOperationView(owner) || state.live === null) render();
}

export async function revokeDevice(device: DeviceSummary): Promise<void> {
  if (device.self) {
    await revokeSelf();
    return;
  }
  const session = state.live;
  const name = displayDeviceLabel(device.label || "") || t("device.unnamed");
  if (!session || !state.credential) return;
  const owner = operationOwner(session);
  if (!(await askConfirm(t("live.unpairDeviceAsk", { name }), t("settings.unpairOther"))) || !ownsOperationView(owner)) return;
  try {
    await session.revokeDevice(device.device_id);
    if (!ownsOperationView(owner)) return;
    const listed = await session.listDevices();
    if (!ownsOperationView(owner)) return;
    state.deviceList = Array.isArray(listed.devices) ? listed.devices : [];
    state.devicesError = "";
    showStatus(t("live.unpairedDevice", { name }));
    render();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

type OperationOwner = { session: LiveSession; scope: NoticeScope; incarnation: number; lockId?: number };

function operationOwner(session: LiveSession): OperationOwner {
  return { session, scope: captureNoticeScope(), incarnation: currentViewIncarnation() };
}

function ownsComputer(owner: OperationOwner): boolean {
  return state.live === owner.session && (state.credential?.daemonId ?? null) === owner.scope.daemonId;
}

function ownsOperationView(owner: OperationOwner): boolean {
  return ownsComputer(owner) && owner.incarnation === currentViewIncarnation() && noticeScopeIsCurrent(owner.scope)
    && (owner.lockId === undefined || promptLockHeld(owner.lockId));
}

async function reportOwnedError(owner: OperationOwner, error: unknown): Promise<void> {
  await reconcileAmbiguousMutation(owner.session, error, undefined, () => ownsOperationView(owner));
  if (!ownsOperationView(owner)) return;
  showError(messageOf(error), owner.scope);
  render();
}


type HerdOperationOptions<T> = {
  owner?: OperationOwner;
  capability?: keyof typeof state.operationCapabilities;
  after?: (result: T, owner: OperationOwner) => Promise<void>;
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
  const owner = options.owner ?? operationOwner(state.live);
  if (!ownsOperationView(owner) || (options.capability && !state.operationCapabilities[options.capability])) return;
  const session = owner.session;
  const lockId = acquirePromptLock();
  if (lockId === null) return;
  owner.lockId = lockId;
  const { after, reconcileWorktrees } = options;
  const noticeScope = options.noticeScope ?? owner.scope;
  showStatus(pending, true, noticeScope);
  const pendingNotice = state.notice;
  const clearPendingNotice = () => { if (state.notice === pendingNotice) clearNoticeForScope(noticeScope); };
  render();
  try {
    const result = await action();
    if (!ownsOperationView(owner)) return;
    if (after) await after(result, owner);
    else await refreshFromSession();
    if (ownsOperationView(owner)) showStatus(success, false, options.noticeScope ?? owner.scope);
    else clearPendingNotice();
  } catch (error) {
    await reconcileAmbiguousMutation(session, error, reconcileWorktrees, () => ownsOperationView(owner));
    if (ownsOperationView(owner)) showError(messageOf(error), noticeScope);
    else clearPendingNotice();
  } finally {
    if (!ownsOperationView(owner)) clearPendingNotice();
    const released = releasePromptLock(owner.lockId!);
    if (released && ownsComputer(owner)) render();
  }
}

async function selectCreatedPane(result: { pane_id?: string; workspace_id?: string; tab_id?: string }, owner: OperationOwner): Promise<void> {
  const paneId = typeof result.pane_id === "string" && result.pane_id ? result.pane_id : "";
  // Refresh first so the switch below sees the new pane in the snapshot, then
  // reuse the normal open path: it applies the pane's remembered / default
  // view mode and tears down a live full-terminal bridge instead of leaking it.
  if (!ownsOperationView(owner)) return;
  await refreshFromSession();
  if (!ownsOperationView(owner)) return;
  if (state.screen === "board") {
    if (typeof result.workspace_id === "string" && result.workspace_id) state.boardWorkspaceId = result.workspace_id;
    if (typeof result.tab_id === "string" && result.tab_id) {
      state.boardTabId = result.tab_id;
      state.boardFitted = false;
    }
    return;
  }
  if (paneId) {
    const navigation = await openPaneWithOwner(paneId);
    if (ownsComputer(owner) && navigation?.isCurrent()) {
      owner.scope = navigation.scope;
      owner.incarnation = navigation.incarnation;
    }
  }
}

/**
 * CreateWorktree runs as a background job card instead of a global
 * `operationBusy` lock: `git fetch` + `worktree add` can take a while and the
 * rest of the app must stay usable meanwhile. Retry means a new create call
 * with a fresh operation_id; cancel only drops the card (there is no cancel
 * RPC), and a late result is ignored.
 */
function worktreeJobDriver(session: LiveSession, scope: ListWorktreesInput): WorktreeJobDriver {
  return {
    create: (input) => session.createWorktree(input),
    // The job outlives the dialog, so every later effect re-checks the session:
    // a computer switch mid-create must not open a pane from the old herd.
    refresh: async () => {
      if (state.live === session) await refreshFromSession();
    },
    openPane: async (paneId) => {
      if (state.live === session) await openPane(paneId);
    },
    reconcile: (error) => reconcileAmbiguousMutation(session, error, scope),
    messageOf,
    repaint: render,
    succeeded: () => {
      if (state.live === session) showStatus(t("op.createdWorktree"));
    },
  };
}

export async function startNewConversation(): Promise<void> {
  const session = state.live;
  if (!session || !state.operationCapabilities.create_conversation) return;
  const defaults = selectedAgent()?.cwd || state.agents.find((agent) => agent.cwd)?.cwd || "";
  const owner = operationOwner(session);
  const input = await askCreateConversation(state.agentKinds, defaults);
  if (!input || !ownsOperationView(owner) || !state.operationCapabilities.create_conversation) return;
  await runHerdOperation(t("op.creatingConversation"), t("op.createdConversation"), () => session.createConversation(input), {
    owner, capability: "create_conversation", after: selectCreatedPane,
  });
}

export async function createSelectedTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId || !state.operationCapabilities.create_tab) return;
  const owner = operationOwner(session);
  const input = await askCreateTab(state.agentKinds, agent.cwd);
  if (!input || !ownsOperationView(owner) || !state.operationCapabilities.create_tab) return;
  const workspaceId = agent.workspaceId;
  await runHerdOperation(
    t("op.creatingTab"),
    t("op.createdTab"),
    () => session.createTab({ workspace_id: workspaceId, ...input }),
    { owner, capability: "create_tab", after: selectCreatedPane },
  );
}

export async function splitSelectedPane(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !selected || !state.operationCapabilities.split_pane) return;
  const owner = operationOwner(session);
  const input = await askSplitPane(state.agentKinds, selected.cwd);
  if (!input || !ownsOperationView(owner) || !state.operationCapabilities.split_pane) return;
  await runHerdOperation(
    t("op.creatingSplit"),
    t("op.createdSplit"),
    () => session.splitPane({ pane_id: selected.paneId, ...input }),
    { owner, capability: "split_pane", after: selectCreatedPane },
  );
}

export async function promptSelectedAgent(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  if (!session || !canPromptAgent(selected) || !state.operationCapabilities.prompt_agent) return;
  const owner = operationOwner(session);
  const text = await askAgentPrompt();
  if (!text || !ownsOperationView(owner) || !state.operationCapabilities.prompt_agent) return;
  const noticeScope = captureNoticeScope();
  await runHerdOperation(
    t("op.sendingTask"),
    t("op.sentTask"),
    () => session.promptAgent({ pane_id: selected.paneId, text }),
    {
      owner, capability: "prompt_agent", noticeScope,
      after: async () => {
        markPaneSubmitted(selected.paneId);
        if (state.live === session && noticeScopeIsCurrent(noticeScope)) await refreshPane();
      },
    },
  );
}

/**
 * Batch every diff note for one path/layer into ONE PromptAgent call; never
 * one RPC per comment. Oversize batches are refused, never silently clipped,
 * and mutations are never retried automatically on ambiguous outcomes.
 */
export async function sendDiffNotesToAgent(path: string, layer: GitLayer): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  const owner = diffNoteScope();
  if (!session || !path || !owner || !canPromptAgent(selected) || !state.operationCapabilities.prompt_agent) return;
  if (state.operationBusy || diffNoteSendOpen() || !session.isConnected()) return;
  if (owner.session !== session || owner.paneId !== selected.paneId) return;
  const list = diffNotesFor(path, layer);
  if (!list.length) return;
  const composed = composeDiffNotesPrompt(path, layer, list);
  if (composed.truncated) {
    showError(t("diffNotes.tooBig"));
    render();
    return;
  }
  const sentIds = list.map((note) => note.id);
  const noticeScope = captureNoticeScope();
  beginDiffNoteSend(sentIds);
  try {
    await runHerdOperation(
      t("diffNotes.sending"),
      t("diffNotes.sent"),
      () => session.promptAgent({ pane_id: selected.paneId, text: composed.text }),
      {
        noticeScope,
        after: async () => {
          removeDiffNotes(sentIds);
          markPaneSubmitted(selected.paneId);
          if (state.live === session && noticeScopeIsCurrent(noticeScope)) await refreshPane();
        },
      },
    );
  } finally {
    endDiffNoteSend();
  }
}

function selectedWorktreeDefaults(): WorktreeDraft | null {
  const selected = selectedAgent();
  return selected ? worktreeScope(selected.workspaceId, selected.cwd) : null;
}

export async function listSelectedWorktrees(): Promise<void> {
  const session = state.live;
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !state.operationCapabilities.list_worktrees) return;
  const owner = operationOwner(session);
  await showWorktrees(
    async () => {
      const result = await session.listWorktrees(defaults);
      return ownsOperationView(owner) && state.operationCapabilities.list_worktrees ? result : { worktrees: [] };
    },
    state.operationCapabilities.open_worktree
      ? async (item) => {
          if (!ownsOperationView(owner) || !state.operationCapabilities.open_worktree) return;
          try {
            const input = openWorktreeFromSummary(defaults, item);
            if (!input) throw new Error(t("err.worktreeNoTarget"));
            const result = await session.openWorktree(input);
            if (!ownsOperationView(owner)) return;
            await selectCreatedPane(result, owner);
            if (ownsOperationView(owner)) {
              showStatus(t("op.openedWorktree"));
              render();
            }
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
  const owner = operationOwner(session);
  const input = await askWorktree("create", defaults);
  if (!input || !ownsOperationView(owner) || !state.operationCapabilities.create_worktree) return;
  // No `operationBusy` here on purpose: the create runs as a job card so other
  // sessions stay tappable while the daemon does fetch + worktree add.
  if (!startWorktreeJob(worktreeJobDriver(session, defaults), input)) {
    showError(t("op.worktreeJobLimit"));
    render();
  }
}

export async function openSelectedWorktree(): Promise<void> {
  const session = state.live;
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !state.operationCapabilities.open_worktree) return;
  const owner = operationOwner(session);
  const input = await askWorktree("open", defaults);
  if (!input || !ownsOperationView(owner) || !state.operationCapabilities.open_worktree) return;
  await runHerdOperation(t("op.openingWorktree"), t("op.openedWorktree"), () => session.openWorktree(input), {
    owner, capability: "open_worktree", after: selectCreatedPane,
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
  const owner = operationOwner(session);
  if (kind === "zoom") {
    await runHerdOperation(t("op.zooming"), t("op.zoomed"), () =>
      session.zoomPane({ pane_id: selected.paneId, mode: "toggle" }),
      { owner, capability: "zoom_pane" },
    );
    return;
  }
  const choice = await askLayout(kind);
  if (!choice || !ownsOperationView(owner)) return;
  if (choice.kind === "resize") {
    await runHerdOperation(t("op.resizing"), t("op.resized"), () =>
      session.resizePane({ pane_id: selected.paneId, direction: choice.direction, amount: choice.amount }),
      { owner, capability: "resize_pane" },
    );
  } else {
    await runHerdOperation(t("op.swapping"), t("op.swapped"), () =>
      session.swapPane({ pane_id: selected.paneId, direction: choice.direction }),
      { owner, capability: "swap_pane" },
    );
  }
}

function dropPaneIfCurrent(paneId: string): void {
  if (!paneId || state.paneId !== paneId) return;
  parkComposeView();
  disposeFullTerminal();
  dropQueuedKeys();
  state.paneId = "";
  resetPaneView();
  applyComposeDraft();
  if (state.screen === "pane") leavePaneScreen();
}

export async function renamePane(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.paneId) return;
  const owner = operationOwner(session);
  const label = await askText(
    t("op.renamePane"),
    agent.paneLabel || "",
    OPERATION_INPUT_LIMITS.label,
    t("op.paneName"),
  );
  if (label === null || !ownsOperationView(owner)) return;
  try {
    await session.renamePane(agent.paneId, label.trim() || null);
    if (ownsOperationView(owner)) await refreshFromSession();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

export async function renameTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.tabId) return;
  const owner = operationOwner(session);
  const label = await askText(t("op.renameTab"), agent.tabLabel || "", OPERATION_INPUT_LIMITS.label, t("op.tabName"));
  if (label === null || !ownsOperationView(owner)) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.tabNameEmpty"));
    render();
    return;
  }
  try {
    await session.renameTab(agent.tabId, normalized);
    if (ownsOperationView(owner)) await refreshFromSession();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

export async function renameWorkspace(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId) return;
  const owner = operationOwner(session);
  const label = await askText(t("op.renameWorkspace"), agent.workspaceLabel, OPERATION_INPUT_LIMITS.label, t("op.workspaceName"));
  if (label === null || !ownsOperationView(owner)) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.workspaceNameEmpty"));
    render();
    return;
  }
  try {
    await session.renameWorkspace(agent.workspaceId, normalized);
    if (ownsOperationView(owner)) await refreshFromSession();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

export async function closePane(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.paneId) return;
  const owner = operationOwner(session);
  if (!(await askConfirm(t("op.closePaneAsk", { title: agentTitle(agent) }), t("op.closePane")))) return;
  if (!ownsOperationView(owner)) return;
  const paneId = agent.paneId;
  await runHerdOperation(t("op.closingPane"), t("op.closedPane"), async () => {
    if (state.live === session && state.paneId === paneId && state.fullTerminal) {
      const transition = await leaveFullTerminalWithTransition({ rememberGuided: false, paint: false });
      if (!ownsComputer(owner)) return;
      if (transition && transition.from === owner.incarnation && noticeScopeIsCurrent(owner.scope)
        && currentViewIncarnation() === transition.to) {
        owner.incarnation = transition.to;
        // The coordinated full→guided leave retires the view's busy display.
        // Keep this confirmed close busy through its actual pane RPC.
        const renewed = acquirePromptLock();
        if (renewed !== null) owner.lockId = renewed;
      }
    }
    return session.closePane(paneId);
  }, {
    owner,
    after: async () => {
      forgetAgentTrace(paneId);
      dropPaneIfCurrent(paneId);
      owner.scope = captureNoticeScope();
      owner.incarnation = currentViewIncarnation();
      await refreshFromSession();
    },
  });
}

export async function closeTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.tabId) return;
  const label = agent.tabLabel || agent.tabId;
  const owner = operationOwner(session);
  if (!(await askConfirm(t("op.closeTabAsk", { title: label }), t("op.closeTab")))) return;
  if (!ownsOperationView(owner)) return;
  const tabId = agent.tabId;
  const siblings = tabSiblings(agent, state.agents);
  await runHerdOperation(t("op.closingTab"), t("op.closedTab"), () => session.closeTab(tabId), {
    owner,
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = state.paneId;
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
      owner.scope = captureNoticeScope();
      owner.incarnation = currentViewIncarnation();
      await refreshFromSession();
    },
  });
}

export async function closeWorkspace(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId) return;
  const label = agent.workspaceLabel || t("workspace.unnamed");
  const owner = operationOwner(session);
  if (!(await askConfirm(t("op.closeWorkspaceAsk", { title: label }), t("op.closeWorkspace")))) return;
  if (!ownsOperationView(owner)) return;
  const workspaceId = agent.workspaceId;
  const siblings = workspaceSiblings(agent, state.agents);
  await runHerdOperation(t("op.closingWorkspace"), t("op.closedWorkspace"), () => session.closeWorkspace(workspaceId), {
    owner,
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = state.paneId;
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
      owner.scope = captureNoticeScope();
      owner.incarnation = currentViewIncarnation();
      await refreshFromSession();
    },
  });
}

export async function copyScreenText(): Promise<void> {
  const text = parseAnsi(state.paneText)
    .map((line) => line.text)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showStatus(t("live.copied"));
  } catch {
    showError(t("err.copyDenied"));
  }
  render();
}
