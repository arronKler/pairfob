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
import { landAfterDisconnect, openPane, refreshFromSession, refreshPane } from "./live";
import { reconcileAmbiguousMutation, reportMutationError } from "./mutations";
import { render } from "./paint";
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
import { disposeFullTerminal, leaveFullTerminal } from "./ui/full-terminal";
import { dropQueuedKeys } from "./ui/session-view";

export async function revokeSelf(): Promise<void> {
  const session = state.live;
  if (
    !session ||
    !state.credential ||
    !(await askConfirm(t("live.unpairAsk"), t("settings.unpair")))
  )
    return;
  try {
    await session.revokeDevice(state.credential.deviceId);
    const daemonId = state.credential.daemonId;
    await landAfterDisconnect({ daemonId, code: "revoked", silent: true });
    showStatus(t("live.unpaired"));
  } catch (error) {
    await reportMutationError(session, error);
  }
  render();
}

export async function revokeDevice(device: DeviceSummary): Promise<void> {
  if (device.self) {
    await revokeSelf();
    return;
  }
  const session = state.live;
  const name = device.label || t("device.unnamed");
  if (!session || !state.credential || !(await askConfirm(t("live.unpairDeviceAsk", { name }), t("settings.unpairOther")))) {
    return;
  }
  try {
    await session.revokeDevice(device.device_id);
    const listed = await session.listDevices();
    if (state.live === session) {
      state.deviceList = Array.isArray(listed.devices) ? listed.devices : [];
      state.devicesError = "";
    }
    showStatus(t("live.unpairedDevice", { name }));
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

async function selectCreatedPane(result: { pane_id?: string; workspace_id?: string; tab_id?: string }): Promise<void> {
  const paneId = typeof result.pane_id === "string" && result.pane_id ? result.pane_id : "";
  // Refresh first so the switch below sees the new pane in the snapshot, then
  // reuse the normal open path: it applies the pane's remembered / default
  // view mode and tears down a live full-terminal bridge instead of leaking it.
  await refreshFromSession();
  if (state.screen === "board") {
    if (typeof result.workspace_id === "string" && result.workspace_id) state.boardWorkspaceId = result.workspace_id;
    if (typeof result.tab_id === "string" && result.tab_id) {
      state.boardTabId = result.tab_id;
      state.boardFitted = false;
    }
    return;
  }
  if (paneId) await openPane(paneId);
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
  const input = await askCreateConversation(state.agentKinds, defaults);
  if (!input || state.live !== session) return;
  await runHerdOperation(t("op.creatingConversation"), t("op.createdConversation"), () => session.createConversation(input), {
    after: selectCreatedPane,
  });
}

export async function createSelectedTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId || !state.operationCapabilities.create_tab) return;
  const input = await askCreateTab(agent.cwd);
  if (!input || state.live !== session) return;
  const workspaceId = agent.workspaceId;
  await runHerdOperation(
    t("op.creatingTab"),
    t("op.createdTab"),
    () => session.createTab({ workspace_id: workspaceId, ...input }),
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
    t("op.creatingSplit"),
    t("op.createdSplit"),
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
    t("op.sendingTask"),
    t("op.sentTask"),
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
  await showWorktrees(
    () => session.listWorktrees(defaults),
    state.operationCapabilities.open_worktree
      ? async (item) => {
          try {
            const input = openWorktreeFromSummary(defaults, item);
            if (!input) throw new Error(t("err.worktreeNoTarget"));
            const result = await session.openWorktree(input);
            await selectCreatedPane(result);
            showStatus(t("op.openedWorktree"));
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
  const input = await askWorktree("open", defaults);
  if (!input || state.live !== session) return;
  await runHerdOperation(t("op.openingWorktree"), t("op.openedWorktree"), () => session.openWorktree(input), {
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
    await runHerdOperation(t("op.zooming"), t("op.zoomed"), () =>
      session.zoomPane({ pane_id: selected.paneId, mode: "toggle" }),
    );
    return;
  }
  const choice = await askLayout(kind);
  if (!choice || state.live !== session) return;
  if (choice.kind === "resize") {
    await runHerdOperation(t("op.resizing"), t("op.resized"), () =>
      session.resizePane({ pane_id: selected.paneId, direction: choice.direction, amount: choice.amount }),
    );
  } else {
    await runHerdOperation(t("op.swapping"), t("op.swapped"), () =>
      session.swapPane({ pane_id: selected.paneId, direction: choice.direction }),
    );
  }
}

function dropPaneIfCurrent(paneId: string): void {
  if (!paneId || state.paneId !== paneId) return;
  disposeFullTerminal();
  dropQueuedKeys();
  state.paneId = "";
  resetPaneView();
  if (state.screen === "pane") leavePaneScreen();
}

export async function renamePane(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.paneId) return;
  const label = await askText(
    t("op.renamePane"),
    agent.paneLabel || "",
    OPERATION_INPUT_LIMITS.label,
    t("op.paneName"),
  );
  if (label === null) return;
  try {
    await session.renamePane(agent.paneId, label.trim() || null);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function renameTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.tabId) return;
  const label = await askText(t("op.renameTab"), agent.tabLabel || "", OPERATION_INPUT_LIMITS.label, t("op.tabName"));
  if (label === null) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.tabNameEmpty"));
    render();
    return;
  }
  try {
    await session.renameTab(agent.tabId, normalized);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function renameWorkspace(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId) return;
  const label = await askText(t("op.renameWorkspace"), agent.workspaceLabel, OPERATION_INPUT_LIMITS.label, t("op.workspaceName"));
  if (label === null) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.workspaceNameEmpty"));
    render();
    return;
  }
  try {
    await session.renameWorkspace(agent.workspaceId, normalized);
    await refreshFromSession();
  } catch (error) {
    await reportMutationError(session, error);
  }
}

export async function closePane(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.paneId) return;
  if (!(await askConfirm(t("op.closePaneAsk", { title: agentTitle(agent) }), t("op.closePane")))) return;
  const paneId = agent.paneId;
  await runHerdOperation(t("op.closingPane"), t("op.closedPane"), async () => {
    if (state.live === session && state.paneId === paneId && state.fullTerminal) {
      await leaveFullTerminal({ rememberGuided: false, paint: false });
    }
    return session.closePane(paneId);
  }, {
    after: async () => {
      forgetAgentTrace(paneId);
      dropPaneIfCurrent(paneId);
      await refreshFromSession();
    },
  });
}

export async function closeTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.tabId) return;
  const label = agent.tabLabel || agent.tabId;
  if (!(await askConfirm(t("op.closeTabAsk", { title: label }), t("op.closeTab")))) return;
  const tabId = agent.tabId;
  const siblings = tabSiblings(agent, state.agents);
  await runHerdOperation(t("op.closingTab"), t("op.closedTab"), () => session.closeTab(tabId), {
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = state.paneId;
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
      await refreshFromSession();
    },
  });
}

export async function closeWorkspace(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = state.live;
  if (!session || !agent?.workspaceId) return;
  const label = agent.workspaceLabel || t("workspace.unnamed");
  if (!(await askConfirm(t("op.closeWorkspaceAsk", { title: label }), t("op.closeWorkspace")))) return;
  const workspaceId = agent.workspaceId;
  const siblings = workspaceSiblings(agent, state.agents);
  await runHerdOperation(t("op.closingWorkspace"), t("op.closedWorkspace"), () => session.closeWorkspace(workspaceId), {
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = state.paneId;
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
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
