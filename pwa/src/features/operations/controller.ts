import { parseAnsi } from "../../lib/ansi";
import { agentStatusLabel, agentTitle, canPromptAgent, tabSiblings, workspaceSiblings } from "../../lib/dashboard";
import {
  beginDiffNoteSend,
  composeDiffNotesPrompt,
  diffNoteScope,
  diffNoteSendOpen,
  diffNotesFor,
  endDiffNoteSend,
  removeDiffNotes,
} from "../../lib/diff-notes";
import { askConfirm, askText } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { displayDeviceLabel } from "../../lib/ui-model";
import { clearAgentTraceCache, forgetAgentTrace } from "../../lib/agent-trace-cache";
import { type NoticeScope } from "../../lib/notice-scope";
import {
  OPERATION_INPUT_LIMITS,
  reconcileMutationFailure,
  openWorktreeFromSummary,
  worktreeScope,
  type CreateConversationInput,
  type CreateWorktreeInput,
  type OpenWorktreeInput,
  type ListWorktreesInput,
  type CreateTabInput,
  type WorktreeDraft,
  type SplitDirection,
  type SplitPaneInput,
  type WorktreeSummary,
  parseWorktrees,
} from "../../lib/operations";
import { type GitLayer } from "../../lib/workspace";
import { askAgentPrompt, askCreateConversation, askCreateTab, askSplitPane, showWorktrees } from "./operation-ui";
import { ProtocolError, type DeviceSummary, type LiveSession } from "../../lib/protocol/client";
import { type AgentCard } from "../../lib/ranking";
import { startWorktreeJob, type WorktreeJobDriver } from "../../lib/worktree-jobs";
import { applyComposeDraft, acquirePromptLock, currentViewIncarnation, parkComposeView, releasePromptLock } from "../session/drafts/compose-drafts";
import { liveView } from "../connection/generations";
import { boardStore, focusBoard, selectBoardTab, selectBoardWorkspace } from "../board/layout-store";
import { advertisedAgentKinds, capabilitiesStore, capabilityEnabled, operationBusy } from "./capabilities-store";
import { computersStore, currentDaemonId, liveSession } from "../computers/catalog-store";
import { dashboardStore, selectedAgent } from "../dashboard/catalog-store";
import { currentScreen, leavePaneScreen } from "../../app/navigation-store";
import { connectionStore } from "../connection/connection-store";
import { applyDeviceList } from "../connection/runtime-store";
import { isFullTerminal, openPaneId, selectPane, sessionStore } from "../session/session-store";
import { landAfterDisconnect, openPane, openPaneWithOwner, refreshFromSession, refreshPane } from "../connection/controller";
import { reconcileAmbiguousMutation, refreshSnapshotOnly } from "../connection/mutations";
import { commitView } from "../../app/host";
import { promptLockHeld } from "../session/drafts/state-drafts";
import { captureNoticeScope, noticeScopeIsCurrent, showError, showStatus } from "../../app/notices-store";
import { markPaneSubmitted } from "../dashboard/catalog-store";
import { messageOf } from "../../lib/notices";
import { resetPaneView } from "../session/session-store";
import { openWorktreeTargetError, type SheetOutcome } from "./operation-form-model";
import { followWorktreeJob } from "./worktree-outcome";
import { showWorktreeForm, type OperationGate } from "./worktree-sheet";
import { takesSheetPlace } from "./worktree-steps";
import { disposeFullTerminal, leaveFullTerminalWithTransition } from "../session/full-terminal/full-terminal";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import {
  operationOwner as ownedOperation,
  ownsComputer as ownerOwnsComputer,
  ownsOperationView as ownerOwnsView,
  reportOwnedError as reportError,
  runHerdOperation as runOwnedOperation,
  NOT_RUN,
  sheetOutcome,
  type MutationRunnerPorts,
  type OperationOwner,
} from "./run";

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

const mutationPorts: MutationRunnerPorts = {
  currentIncarnation: currentViewIncarnation,
  currentViewVersion: liveView,
  promptLockHeld,
  currentLive: liveSession,
  currentDaemonId: () => currentDaemonId(),
  busy: operationBusy,
  connected: () => liveSession()?.isConnected() === true,
  capabilityEnabled,
  acquirePromptLock,
  releasePromptLock,
  reconcile: reconcileAmbiguousMutation,
  refreshFromSession,
  commitView,
};

function operationOwner(session: LiveSession): OperationOwner {
  return ownedOperation(session, currentViewIncarnation(), liveView());
}

function ownsComputer(owner: OperationOwner): boolean {
  return ownerOwnsComputer(owner, liveSession(), currentDaemonId());
}

function ownsOperationView(owner: OperationOwner): boolean {
  return ownerOwnsView(owner, mutationPorts, liveSession(), currentDaemonId());
}

async function reportOwnedError(owner: OperationOwner, error: unknown): Promise<void> {
  await reportError(owner, error, mutationPorts);
}

type HerdOperationOptions<T> = {
  owner?: OperationOwner;
  capability?: Parameters<typeof capabilityEnabled>[0];
  conflictMessage?: string;
  unsupportedMessage?: string;
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
  await runOwnedOperation(pending, success, action, mutationPorts, options);
}

export type { SheetOutcome };

async function selectCreatedPane(result: { pane_id?: string; workspace_id?: string; tab_id?: string }, owner: OperationOwner): Promise<void> {
  const paneId = typeof result.pane_id === "string" && result.pane_id ? result.pane_id : "";
  // Refresh first so the switch below sees the new pane in the snapshot, then
  // reuse the normal open path: it applies the pane's remembered / default
  // view mode and tears down a live full-terminal bridge instead of leaking it.
  if (!ownsOperationView(owner)) return;
  await refreshFromSession();
  if (!ownsOperationView(owner)) return;
  if (currentScreen() === "board") {
    const workspaceId = typeof result.workspace_id === "string" ? result.workspace_id : "";
    const tabId = typeof result.tab_id === "string" ? result.tab_id : "";
    if (workspaceId && tabId) focusBoard(workspaceId, tabId);
    else if (workspaceId) selectBoardWorkspace(workspaceId, boardStore.get().boardTabId);
    else if (tabId) selectBoardTab(tabId);
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
  const herdSession = session.herdSession?.() ?? null;
  const sameTarget = () => (session.herdSession?.() ?? null) === herdSession;
  const ownsTarget = () => liveSession() === session && sameTarget();
  return {
    create: async (input) => {
      if (!sameTarget()) throw new ProtocolError("conflict", t("err.worktreeSessionChanged"));
      return session.createWorktree(input);
    },
    // The job outlives the dialog: effects must still own both the connection
    // and its original Herdr target after every awaited step.
    refresh: async () => {
      if (ownsTarget()) await refreshFromSession();
    },
    openPane: async (paneId) => {
      if (ownsTarget()) await openPane(paneId);
    },
    reconcile: (error) => reconcileMutationFailure(error, {
      snapshot: async () => { if (ownsTarget()) await refreshSnapshotOnly(session, ownsTarget); },
      listWorktrees: async () => { if (ownsTarget()) await session.listWorktrees(scope); },
    }).then(() => undefined),
    messageOf,
    repaint: commitView,
    succeeded: () => {
      if (ownsTarget()) showStatus(t("op.createdWorktree"));
    },
  };
}

/** `prepared` is input the create sheet already collected. */
export async function startNewConversation(prepared?: CreateConversationInput): Promise<void> {
  const session = liveSession();
  if (!session || !capabilityEnabled("create_conversation")) return;
  const defaults = selectedAgent()?.cwd || dashboardStore.get().agents.find((agent) => agent.cwd)?.cwd || "";
  const owner = operationOwner(session);
  const input = prepared ?? await askCreateConversation([...advertisedAgentKinds()], defaults);
  if (!input || !ownsOperationView(owner) || !capabilityEnabled("create_conversation")) return;
  await runHerdOperation(t("op.creatingConversation"), t("op.createdConversation"), () => session.createConversation(input), {
    owner, capability: "create_conversation", conflictMessage: t("err.createPaneConflict"), after: selectCreatedPane,
  });
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
      after: async (result, scope) => { await selectCreatedPane(result, scope); done(); } },
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
    options.direction ? { direction: options.direction, title: agentTitle(selected) } : undefined);
  if (!input || !ownsOperationView(owner) || !capabilityEnabled("split_pane")) return NOT_RUN;
  return sheetOutcome(done => runHerdOperation(
    t("op.creatingSplit"),
    t("op.createdSplit"),
    () => { requirePaneTarget(selected, options); return session.splitPane({ pane_id: selected.paneId, ...input }); },
    { owner, capability: "split_pane", conflictMessage: t("err.createPaneConflict"), after: async (result, scope) => {
      // An explicit board target owns neither global pane selection nor a new
      // tab focus. Refresh without resetting its camera or pulling a reader
      // back to the old tab after an in-flight create.
      if (options.valid) await refreshFromSession();
      else await selectCreatedPane(result, scope);
      if (ownsOperationView(scope) && options.valid?.() !== false && result.pane_id) options.created?.(result.pane_id);
      done();
    } },
  ));
}

export async function promptSelectedAgent(): Promise<void> {
  const session = liveSession();
  const selected = selectedAgent();
  if (!session || !canPromptAgent(selected) || !capabilityEnabled("prompt_agent")) return;
  const owner = operationOwner(session);
  const text = await askAgentPrompt();
  if (!text || !ownsOperationView(owner) || !capabilityEnabled("prompt_agent")) return;
  const noticeScope = captureNoticeScope();
  await runHerdOperation(
    t("op.sendingTask"),
    t("op.sentTask"),
    () => session.promptAgent({ pane_id: selected.paneId, text }),
    {
      owner, capability: "prompt_agent", noticeScope,
      after: async () => {
        markPaneSubmitted(selected.paneId);
        if (liveSession() === session && noticeScopeIsCurrent(noticeScope)) await refreshPane();
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
  const session = liveSession();
  const selected = selectedAgent();
  const owner = diffNoteScope();
  if (!session || !path || !owner || !canPromptAgent(selected) || !capabilityEnabled("prompt_agent")) return;
  if (operationBusy() || diffNoteSendOpen() || !session.isConnected()) return;
  if (owner.session !== session || owner.paneId !== selected.paneId) return;
  const list = diffNotesFor(path, layer);
  if (!list.length) return;
  const composed = composeDiffNotesPrompt(path, layer, list);
  if (composed.truncated) {
    showError(t("diffNotes.tooBig"));
    commitView();
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
          if (liveSession() === session && noticeScopeIsCurrent(noticeScope)) await refreshPane();
        },
      },
    );
  } finally {
    endDiffNoteSend();
  }
}

function selectedWorktreeDefaults(selected: Pick<AgentCard, "workspaceId" | "cwd"> | undefined = selectedAgent()): WorktreeDraft | null {
  return selected ? worktreeScope(selected.workspaceId, selected.cwd) : null;
}

/** The pane sheet's Worktree list, read in place. Throws what the page shows. */
export async function loadPaneWorktrees(agent: AgentCard): Promise<WorktreeSummary[]> {
  const session = liveSession();
  const scope = selectedWorktreeDefaults(agent);
  if (!session || !scope || !capabilityEnabled("list_worktrees")) return [];
  return parseWorktrees(await session.listWorktrees(scope));
}

/** Open a listed Worktree, or one named by path or branch, from the pane sheet. */
export async function openPaneWorktree(agent: AgentCard, target: { path?: string; branch?: string; label?: string }): Promise<SheetOutcome> {
  const session = liveSession();
  const scope = selectedWorktreeDefaults(agent);
  if (!session || !scope || !capabilityEnabled("open_worktree")) return NOT_RUN;
  const path = target.path?.trim() || "";
  const branch = target.branch?.trim() || "";
  const invalid = openWorktreeTargetError(path, branch);
  if (invalid) return { ok: false, message: invalid };
  const input = { ...scope, ...(path ? { path } : { branch }), ...(target.label ? { label: target.label } : {}) } as OpenWorktreeInput;
  return sheetOutcome(done => runHerdOperation(t("op.openingWorktree"), t("op.openedWorktree"), () => session.openWorktree(input), {
    capability: "open_worktree", reconcileWorktrees: scope,
    after: async (result, owner) => { await selectCreatedPane(result, owner); done(); },
  }));
}

/**
 * Start the background create job for the pane's repository. The promise
 * settles with the job, for the form that stays open on it; null when no job
 * could be started.
 */
export function createPaneWorktree(agent: AgentCard, fields: { branch?: string; base?: string; label?: string; path?: string }): Promise<SheetOutcome> | null {
  const scope = selectedWorktreeDefaults(agent);
  if (!scope) return null;
  const input: CreateWorktreeInput = { ...scope };
  for (const key of ["branch", "base", "label", "path"] as const) {
    const text = fields[key]?.trim();
    if (text) input[key] = text;
  }
  return startWorktree(input);
}

/**
 * Why a form that runs its operation in place cannot run it right now:
 * offline, or another operation holds the lock. The session panel's pages and
 * the same forms in a dialog of their own follow this one reading.
 */
export const operationGate: OperationGate = {
  subscribe(listener) {
    const stops = [capabilitiesStore.subscribe(listener), connectionStore.subscribe(listener)];
    return () => { for (const stop of stops) stop(); };
  },
  read: () => !connectionStore.get().networkOnline || !liveSession()?.isConnected() ? t("boardMenu.offline")
    : operationBusy() ? t("boardMenu.busy") : "",
};

/**
 * The repository's Worktrees in a dialog. Resolves once the list is read;
 * `closed` hears how the dialog went away, as the two forms below tell it:
 * true when a Worktree was opened from it, false when it was only put away.
 * Asked from a finger's sheet it takes that sheet's place (`worktree-steps`).
 */
export const listSelectedWorktrees = takesSheetPlace(async (closed?: (opened: boolean) => void): Promise<void> => {
  const session = liveSession();
  const defaults = selectedWorktreeDefaults();
  if (!session || !defaults || !capabilityEnabled("list_worktrees")) return closed?.(false);
  const owner = operationOwner(session);
  await showWorktrees(
    async () => {
      const result = await session.listWorktrees(defaults);
      return ownsOperationView(owner) && capabilityEnabled("list_worktrees") ? result : { worktrees: [] };
    },
    capabilityEnabled("open_worktree")
      ? async (item) => {
          if (!ownsOperationView(owner) || !capabilityEnabled("open_worktree")) return;
          try {
            const input = openWorktreeFromSummary(defaults, item);
            if (!input) throw new Error(t("err.worktreeNoTarget"));
            const result = await session.openWorktree(input);
            if (!ownsOperationView(owner)) return;
            await selectCreatedPane(result, owner);
            if (ownsOperationView(owner)) {
              showStatus(t("op.openedWorktree"));
              commitView();
            }
          } catch (error) {
            await reconcileAmbiguousMutation(session, error, defaults);
            if (error instanceof ProtocolError) throw new ProtocolError(error.code, messageOf(error));
            throw error;
          }
        }
      : undefined,
    closed,
  );
});

/**
 * New Worktree for the selected session's repository, asked from outside the
 * session panel: the panel's own form in a sheet of its own (`worktree-sheet`),
 * run in place at every width. `closed` hears how the form went away: true
 * when it closed on the Worktree it created, false when the reader put it away.
 */
export async function createSelectedWorktree(closed?: (created: boolean) => void): Promise<void> {
  const agent = selectedAgent();
  if (!liveSession() || !agent || !selectedWorktreeDefaults(agent) || !capabilityEnabled("create_worktree")) return closed?.(false);
  const created = await showWorktreeForm({ kind: "create", gate: operationGate, dir: agent.workspaceCwd || agent.cwd,
    start: fields => createPaneWorktree(agent, fields) });
  closed?.(created);
}

/**
 * Start the create job for the repository `input` names. The promise settles
 * with the job (`worktree-outcome`); null when no job could be started.
 */
function startWorktree(input: CreateWorktreeInput): Promise<SheetOutcome> | null {
  const session = liveSession();
  const scope = worktreeScope(input.workspace_id, input.cwd);
  if (!session || !scope || !capabilityEnabled("create_worktree")) return null;
  const followed = followWorktreeJob(worktreeJobDriver(session, scope));
  const job = startWorktreeJob(followed.driver, input);
  if (job) return followed.outcome(job);
  showError(t("op.worktreeJobLimit"));
  commitView();
  return null;
}

/**
 * Create a worktree the create sheet described, scoped by the repository
 * directory it names. Runs as the same background job card as the menu path.
 */
export function createWorktreeFrom(input: CreateWorktreeInput): boolean {
  return startWorktree(input) !== null;
}

/** Open a Worktree by path or branch, asked from outside the session panel; as `createSelectedWorktree`. */
export async function openSelectedWorktree(closed?: (opened: boolean) => void): Promise<void> {
  const agent = selectedAgent();
  if (!liveSession() || !agent || !selectedWorktreeDefaults(agent) || !capabilityEnabled("open_worktree")) return closed?.(false);
  const opened = await showWorktreeForm({ kind: "open", gate: operationGate, open: target => openPaneWorktree(agent, target) });
  closed?.(opened);
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
