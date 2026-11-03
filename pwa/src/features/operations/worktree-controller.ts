/**
 * Worktree operations of the selected session's repository: the list, opening
 * one, and creating one as a background job.
 */
import { commitView } from "../../app/host";
import { showError, showStatus } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import { messageOf } from "../../lib/notices";
import {
  openWorktreeFromSummary,
  parseWorktrees,
  reconcileMutationFailure,
  worktreeScope,
  type CreateWorktreeInput,
  type ListWorktreesInput,
  type OpenWorktreeInput,
  type WorktreeDraft,
  type WorktreeSummary,
} from "../../lib/operations";
import { ProtocolError, type LiveSession } from "../../lib/protocol/client";
import { type AgentCard } from "../../lib/ranking";
import { startWorktreeJob, type WorktreeJobDriver } from "../../lib/worktree-jobs";
import { liveSession } from "../computers/catalog-store";
import { connectionStore } from "../connection/connection-store";
import { openPane, refreshFromSession } from "../connection/controller";
import { reconcileAmbiguousMutation, refreshSnapshotOnly } from "../connection/mutations";
import { selectedAgent } from "../dashboard/catalog-store";
import { capabilitiesStore, capabilityEnabled, operationBusy } from "./capabilities-store";
import { selectCreatedPane } from "./created-pane";
import { operationOwner, ownsOperationView, runHerdOperation } from "./live-run";
import { openWorktreeTargetError, type SheetOutcome } from "./operation-form-model";
import { showWorktrees } from "./operation-ui";
import { NOT_RUN, sheetOutcome } from "./run";
import { followWorktreeJob } from "./worktree-outcome";
import { showWorktreeForm, type OperationGate } from "./worktree-sheet";

/**
 * CreateWorktree runs as a background job card instead of a global
 * `operationBusy` lock: `git fetch` + `worktree add` can take a while and the
 * rest of the app must stay usable meanwhile. Retry means a new create call
 * with a fresh operation_id; cancel only drops the card (there is no cancel
 * RPC), and a late result is ignored.
 */
function worktreeJobDriver(session: LiveSession, scope: ListWorktreesInput): {
  driver: WorktreeJobDriver;
  owns: () => boolean;
} {
  const herdSession = session.herdSession?.() ?? null;
  const sameTarget = () => (session.herdSession?.() ?? null) === herdSession;
  const ownsTarget = () => liveSession() === session && sameTarget();
  return {
    owns: ownsTarget,
    driver: {
      create: async (input) => {
        if (!ownsTarget()) throw new ProtocolError("conflict", t("err.worktreeSessionChanged"));
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
    },
  };
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
 */
export async function listSelectedWorktrees(closed?: (opened: boolean) => void): Promise<void> {
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
}

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
  const { driver, owns } = worktreeJobDriver(session, scope);
  const followed = followWorktreeJob(driver);
  const job = startWorktreeJob(followed.driver, input, owns);
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
