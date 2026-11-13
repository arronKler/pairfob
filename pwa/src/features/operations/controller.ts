import { parseAnsi } from "../../lib/ansi";
import { agentStatusLabel, agentTitle, tabSiblings, workspaceSiblings } from "../../lib/dashboard";
import { askConfirm, askText } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { displayDeviceLabel } from "../../lib/ui-model";
import { forgetAgentTrace } from "../../lib/agent-trace-cache";
import {
  OPERATION_INPUT_LIMITS,
  type CreateConversationInput,
  type CreateTabInput,
  type SplitDirection,
  type SplitPaneInput,
} from "../../lib/operations";
import { askCreateConversation, askCreateTab, askSplitPane } from "./operation-ui";
import { ProtocolError, type DeviceSummary, type LiveSession } from "../../lib/protocol/client";
import { type AgentCard } from "../../lib/ranking";
import { applyComposeDraft, acquirePromptLock, currentViewIncarnation, parkComposeView } from "../session/drafts/compose-drafts";
import { advertisedAgentKinds, capabilityEnabled, operationBusy } from "./capabilities-store";
import { computersStore, liveSession } from "../computers/catalog-store";
import { dashboardStore, selectedAgent } from "../dashboard/catalog-store";
import { currentScreen, leavePaneScreen } from "../../app/navigation-store";
import { applyDeviceList } from "../connection/runtime-store";
import { isFullTerminal, openPaneId, selectPane, sessionStore } from "../session/session-store";
import { landAfterDisconnect, refreshFromSession } from "../connection/controller";
import { reconcileAmbiguousMutation } from "../connection/mutations";
import { commitView } from "../../app/host";
import { captureNoticeScope, noticeScopeIsCurrent, showError, showStatus } from "../../app/notices-store";
import { messageOf } from "../../lib/notices";
import { resetPaneView } from "../session/session-store";
import { type SheetOutcome } from "./operation-form-model";
import { disposeFullTerminal, leaveFullTerminalWithTransition } from "../session/full-terminal/full-terminal";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { selectCreatedPane } from "./created-pane";
import { operationOwner, ownsComputer, ownsOperationView, reportOwnedError, runHerdOperation } from "./live-run";
import { NOT_RUN, sheetOutcome, type OperationOwner } from "./run";

/**
 * The operations a reader runs on the selected session, its tab and its
 * workspace: pairing, creating, layout, renaming and closing. Prompts to the
 * agent (`agent-prompt`) and Worktrees (`worktree-controller`) have modules of
 * their own and are named here too, for the callers that know one controller.
 */
export { promptSelectedAgent, sendAllDiffNotesToAgent, sendDiffNotesToAgent } from "./agent-prompt";
export {
  createPaneWorktree,
  createSelectedWorktree,
  createWorktreeFrom,
  listSelectedWorktrees,
  loadPaneWorktrees,
  openPaneWorktree,
  openSelectedWorktree,
  operationGate,
} from "./worktree-controller";

export async function revokeSelf(): Promise<void> {
  const session = liveSession();
  const credential = computersStore.get().credential;
  if (!session || !credential) return;
  const owner = operationOwner(session);
  if (!(await askConfirm({ title: t("confirm.unpairSelfTitle"), message: t("live.unpairAsk"), confirmLabel: t("settings.unpair") }))
    || !ownsOperationView(owner)) return;
  try {
    await session.revokeDevice(credential.deviceId);
    if (!ownsOperationView(owner)) return;
    await landAfterDisconnect({ daemonId: credential.daemonId, code: "revoked", silent: true });
    showStatus(t("live.unpaired"));
  } catch (error) {
    await reportOwnedError(owner, error);
  }
  if (ownsOperationView(owner) || liveSession() === null) commitView();
}

export async function revokeDevice(device: DeviceSummary): Promise<void> {
  if (device.self) {
    await revokeSelf();
    return;
  }
  const session = liveSession();
  const name = displayDeviceLabel(device.label || "") || t("device.unnamed");
  if (!session || !computersStore.get().credential) return;
  const owner = operationOwner(session);
  if (!(await askConfirm({ title: t("confirm.unpairDeviceTitle"), subject: { name }, message: t("confirm.unpairDeviceEffect"),
    confirmLabel: t("settings.unpairOther") })) || !ownsOperationView(owner)) return;
  try {
    await session.revokeDevice(device.device_id);
    if (!ownsOperationView(owner)) return;
    const listed = await session.listDevices();
    if (!ownsOperationView(owner)) return;
    applyDeviceList(Array.isArray(listed.devices) ? listed.devices : []);
    showStatus(t("live.unpairedDevice", { name }));
    commitView();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

export type { SheetOutcome };

/** `prepared` is input the create sheet already collected. */
export async function startNewConversation(prepared?: CreateConversationInput): Promise<SheetOutcome> {
  const session = liveSession();
  if (!session || !capabilityEnabled("create_conversation")) return NOT_RUN;
  const defaults = selectedAgent()?.cwd || dashboardStore.get().agents.find((agent) => agent.cwd)?.cwd || "";
  const owner = operationOwner(session);
  const input = prepared ?? await askCreateConversation([...advertisedAgentKinds()], defaults);
  if (!input || !ownsOperationView(owner) || !capabilityEnabled("create_conversation")) return NOT_RUN;
  return sheetOutcome(done => runHerdOperation(t("op.creatingConversation"), t("op.createdConversation"), () => session.createConversation(input), {
    owner, capability: "create_conversation", conflictMessage: t("err.createPaneConflict"), invalidArgumentMessage: t("create.checkDirectory"),
    after: async (result, scope) => { await selectCreatedPane(result, scope, input.agent_kind); done(); },
  }));
}

/** `prepared` is input a caller already collected in its own form (the pane sheet). */
export async function createSelectedTab(agent: AgentCard | undefined = selectedAgent(),
  prepared?: Omit<CreateTabInput, "workspace_id">): Promise<SheetOutcome> {
  const session = liveSession();
  if (!session || !agent?.workspaceId || !capabilityEnabled("create_tab")) return NOT_RUN;
  const owner = operationOwner(session);
  const input = prepared ?? await askCreateTab([...advertisedAgentKinds()], agent.cwd);
  if (!input || !ownsOperationView(owner) || !capabilityEnabled("create_tab")) return NOT_RUN;
  const workspaceId = agent.workspaceId;
  return sheetOutcome(done => runHerdOperation(
    t("op.creatingTab"),
    t("op.createdTab"),
    () => session.createTab({ workspace_id: workspaceId, ...input }),
    { owner, capability: "create_tab", conflictMessage: t("err.createPaneConflict"),
      after: async (result, scope) => { await selectCreatedPane(result, scope, input.agent_kind); done(); } },
  ));
}

export type PaneOperationOptions = {
  /** Additional target lifetime, e.g. the board tab that opened the menu. */
  valid?: () => boolean;
  direction?: SplitDirection;
  created?: (paneId: string) => void;
  /** Split input a caller already collected in its own form (the pane sheet). */
  input?: Omit<SplitPaneInput, "pane_id">;
};

function requirePaneTarget(agent: AgentCard, options: PaneOperationOptions): void {
  if (options.valid && (!options.valid() || !dashboardStore.get().agents.some(pane =>
    pane.paneId === agent.paneId && pane.tabId === agent.tabId && pane.workspaceId === agent.workspaceId))) {
    throw new ProtocolError("conflict", t("boardMenu.targetGone"));
  }
}

export async function splitSelectedPane(selected = selectedAgent(), options: PaneOperationOptions = {}): Promise<SheetOutcome> {
  const session = liveSession();
  if (!session || !selected || !capabilityEnabled("split_pane") || options.valid?.() === false) return NOT_RUN;
  const owner = operationOwner(session);
  const input = options.input ?? await askSplitPane([...advertisedAgentKinds()], selected.cwd,
    options.direction ? { direction: options.direction, title: agentTitle(selected) } : undefined, selected.agent);
  if (!input || !ownsOperationView(owner) || !capabilityEnabled("split_pane")) return NOT_RUN;
  return sheetOutcome(done => runHerdOperation(
    t("op.creatingSplit"),
    t("op.createdSplit"),
    () => { requirePaneTarget(selected, options); return session.splitPane({ pane_id: selected.paneId, ...input }); },
    { owner, capability: "split_pane", conflictMessage: t("err.createPaneConflict"), after: async (result, scope) => {
      // An explicit board target owns neither global pane selection nor a new
      // tab focus. Its mark and reveal need the catalog read that adds the new
      // tile, so this sheet still waits for it; the pane's own sheet does not.
      if (options.valid) await refreshFromSession();
      else await selectCreatedPane(result, scope, input.agent_kind);
      if (ownsOperationView(scope) && options.valid?.() !== false && result.pane_id) options.created?.(result.pane_id);
      done();
    } },
  ));
}

export async function layoutSelectedPane(kind: "resize" | "swap" | "zoom", selected = selectedAgent(),
  options: PaneOperationOptions & { choice?: import("./operation-forms").LayoutChoice; zoomMode?: "on" | "off" } = {}): Promise<void> {
  const session = liveSession();
  const allowed =
    kind === "resize"
      ? capabilityEnabled("resize_pane")
      : kind === "swap"
        ? capabilityEnabled("swap_pane")
        : capabilityEnabled("zoom_pane");
  if (!session || !selected || !allowed || options.valid?.() === false) return;
  const owner = operationOwner(session);
  if (kind === "zoom") {
    // The notice says which way it went: leaving the zoom is not "zoomed".
    const off = options.zoomMode === "off";
    await runHerdOperation(t(off ? "op.unzooming" : "op.zooming"), t(off ? "op.unzoomed" : "op.zoomed"), () => {
      requirePaneTarget(selected, options);
      return session.zoomPane({ pane_id: selected.paneId, mode: options.zoomMode ?? "toggle" }); },
      { owner, capability: "zoom_pane" },
    );
    return;
  }
  // Resize and swap are picked in a live panel (pane sheet or board menu) that passes the choice.
  const choice = options.choice;
  if (!choice || choice.kind !== kind || !ownsOperationView(owner)) return;
  if (choice.kind === "resize") {
    await runHerdOperation(t("op.resizing"), t("op.resized"), () => {
      requirePaneTarget(selected, options);
      return session.resizePane({ pane_id: selected.paneId, direction: choice.direction, amount: choice.amount }); },
      { owner, capability: "resize_pane" },
    );
  } else {
    await runHerdOperation(t("op.swapping"), t("op.swapped"), () => {
      requirePaneTarget(selected, options);
      return session.swapPane({ pane_id: selected.paneId, direction: choice.direction }); },
      { owner, capability: "swap_pane" },
    );
  }
}

function dropPaneIfCurrent(paneId: string): void {
  if (!paneId || openPaneId() !== paneId) return;
  parkComposeView();
  disposeFullTerminal();
  dropQueuedKeys();
  selectPane("");
  resetPaneView();
  applyComposeDraft();
  if (currentScreen() === "pane") leavePaneScreen();
}

export async function renamePane(agent: AgentCard | undefined = selectedAgent(), options: PaneOperationOptions = {}): Promise<void> {
  const session = liveSession();
  if (!session || !agent?.paneId || options.valid?.() === false) return;
  const owner = operationOwner(session);
  const label = await askText({
    title: t("menu.renamePane"),
    initial: agent.paneLabel || "",
    maxLength: OPERATION_INPUT_LIMITS.label,
    label: t("op.paneName"),
    hint: t("text.paneHint"),
    emptyHint: t("text.paneEmptyHint"),
  });
  if (label === null || !ownsOperationView(owner)) return;
  const outcome = await applyPaneLabel(session, owner, agent, label, options);
  if (!outcome.ok && outcome.message && ownsOperationView(owner)) {
    showError(outcome.message, owner.scope);
    commitView();
  }
}

/** Rename from a form that stays open (the pane sheet); blank restores the automatic name. */
export async function renamePaneTo(agent: AgentCard, label: string, options: PaneOperationOptions = {}): Promise<SheetOutcome> {
  const session = liveSession();
  if (!session || !agent.paneId || options.valid?.() === false) return NOT_RUN;
  return applyPaneLabel(session, operationOwner(session), agent, label, options);
}

async function applyPaneLabel(session: LiveSession, owner: OperationOwner, agent: AgentCard, label: string,
  options: PaneOperationOptions): Promise<SheetOutcome> {
  try {
    requirePaneTarget(agent, options);
    if (!session.isConnected() || operationBusy()) return NOT_RUN;
    await session.renamePane(agent.paneId, label.trim().slice(0, OPERATION_INPUT_LIMITS.label) || null);
    if (ownsOperationView(owner)) await refreshFromSession();
    return { ok: true };
  } catch (error) {
    await reconcileAmbiguousMutation(owner.session, error, undefined, () => ownsOperationView(owner));
    return { ok: false, message: messageOf(error) };
  }
}

export async function renameTab(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = liveSession();
  if (!session || !agent?.tabId) return;
  const owner = operationOwner(session);
  const label = await askText({ title: t("menu.renameTab"), initial: agent.tabLabel || "", maxLength: OPERATION_INPUT_LIMITS.label,
    label: t("op.tabName"), allowEmpty: false });
  if (label === null || !ownsOperationView(owner)) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.tabNameEmpty"));
    commitView();
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
  const session = liveSession();
  if (!session || !agent?.workspaceId) return;
  const owner = operationOwner(session);
  const label = await askText({ title: t("menu.renameWorkspace"), initial: agent.workspaceLabel, maxLength: OPERATION_INPUT_LIMITS.label,
    label: t("op.workspaceName"), allowEmpty: false });
  if (label === null || !ownsOperationView(owner)) return;
  const normalized = label.trim();
  if (!normalized) {
    showError(t("err.workspaceNameEmpty"));
    commitView();
    return;
  }
  try {
    await session.renameWorkspace(agent.workspaceId, normalized);
    if (ownsOperationView(owner)) await refreshFromSession();
  } catch (error) {
    await reportOwnedError(owner, error);
  }
}

export async function closePane(agent: AgentCard | undefined = selectedAgent(), options: PaneOperationOptions = {}): Promise<void> {
  const session = liveSession();
  if (!session || !agent?.paneId || options.valid?.() === false) return;
  const owner = operationOwner(session);
  if (!(await askConfirm({
    title: t("confirm.closePaneTitle"),
    subject: { name: agentTitle(agent), detail: agent.cwd || undefined, status: agentStatusLabel(agent) },
    message: t("confirm.closePaneEffect"),
    warning: paneIsRunning(agent) ? t("confirm.closeRunning") : undefined,
    confirmLabel: t("op.closePane"),
  }))) return;
  if (!ownsOperationView(owner)) return;
  await closeConfirmedPane(session, owner, agent, options);
}

/** Closing ends whatever runs in the pane; the confirmation says so louder while an agent is busy. */
export function paneIsRunning(agent: AgentCard): boolean {
  return agent.status === "working" || agent.status === "blocked";
}

/** Close after a confirmation the caller already showed (the pane sheet's inline confirm). */
export async function closePaneConfirmed(agent: AgentCard, options: PaneOperationOptions = {}): Promise<void> {
  const session = liveSession();
  if (!session || !agent.paneId || options.valid?.() === false) return;
  await closeConfirmedPane(session, operationOwner(session), agent, options);
}

async function closeConfirmedPane(session: LiveSession, owner: OperationOwner, agent: AgentCard, options: PaneOperationOptions): Promise<void> {
  const paneId = agent.paneId;
  await runHerdOperation(t("op.closingPane"), t("op.closedPane"), async () => {
    requirePaneTarget(agent, options);
    if (liveSession() === session && openPaneId() === paneId && isFullTerminal()) {
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
  const session = liveSession();
  if (!session || !agent?.tabId) return;
  const label = agent.tabLabel || agent.tabId;
  const owner = operationOwner(session);
  const count = tabSiblings(agent, [...dashboardStore.get().agents]).length;
  if (!(await askConfirm({ title: t("confirm.closeTabTitle"), subject: { name: label, status: t("confirm.paneCount", { n: count }) },
    message: t("confirm.closeGroupEffect"), confirmLabel: t("op.closeTab") }))) return;
  if (!ownsOperationView(owner)) return;
  const tabId = agent.tabId;
  const siblings = tabSiblings(agent, [...dashboardStore.get().agents]);
  await runHerdOperation(t("op.closingTab"), t("op.closedTab"), () => session.closeTab(tabId), {
    owner,
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = openPaneId();
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
      owner.scope = captureNoticeScope();
      owner.incarnation = currentViewIncarnation();
      await refreshFromSession();
    },
  });
}

export async function closeWorkspace(agent: AgentCard | undefined = selectedAgent()): Promise<void> {
  const session = liveSession();
  if (!session || !agent?.workspaceId) return;
  const label = agent.workspaceLabel || t("workspace.unnamed");
  const owner = operationOwner(session);
  const count = workspaceSiblings(agent, [...dashboardStore.get().agents]).length;
  if (!(await askConfirm({ title: t("confirm.closeWorkspaceTitle"),
    subject: { name: label, status: t("confirm.paneCount", { n: count }) },
    message: t("confirm.closeGroupEffect"), confirmLabel: t("op.closeWorkspace") }))) return;
  if (!ownsOperationView(owner)) return;
  const workspaceId = agent.workspaceId;
  const siblings = workspaceSiblings(agent, [...dashboardStore.get().agents]);
  await runHerdOperation(t("op.closingWorkspace"), t("op.closedWorkspace"), () => session.closeWorkspace(workspaceId), {
    owner,
    conflictMessage: t("err.closeWorkspaceConflict"),
    unsupportedMessage: t("err.closeWorkspaceUnsupported"),
    after: async () => {
      for (const pane of siblings) forgetAgentTrace(pane.paneId);
      const open = openPaneId();
      if (open && siblings.some((pane) => pane.paneId === open)) dropPaneIfCurrent(open);
      owner.scope = captureNoticeScope();
      owner.incarnation = currentViewIncarnation();
      await refreshFromSession();
    },
  });
}

export async function copyScreenText(): Promise<void> {
  const text = parseAnsi(sessionStore.get().paneText)
    .map((line) => line.text)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showStatus(t("live.copied"));
  } catch {
    showError(t("err.copyDenied"));
  }
  commitView();
}
