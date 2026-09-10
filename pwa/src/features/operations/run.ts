/**
 * Mutation runner: one operation_id from the protocol session, fail-closed
 * capability check, no automatic retry. unknown_outcome reconciliation is
 * refresh-only and is injected as a port so this module never imports live.ts.
 */
import { clearNoticeForScope, noticesStore, showError, showStatus } from "../../app/notices-store";
import type { NoticeScope } from "../../lib/notice-scope";
import type { ListWorktreesInput, OperationCapability } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { ProtocolError } from "../../lib/protocol/errors";
import { messageOf } from "../../lib/notices";
import {
  ownsComputer,
  ownsOperationView,
  operationOwner,
  type OperationOwner,
  type OperationOwnerPorts,
} from "./owner";

export type MutationRunnerPorts = OperationOwnerPorts & {
  currentLive(): LiveSession | null;
  currentDaemonId(): string | null;
  busy(): boolean;
  connected(): boolean;
  capabilityEnabled(key: OperationCapability): boolean;
  acquirePromptLock(): number | null;
  releasePromptLock(lockId: number): boolean;
  reconcile(session: LiveSession, error: unknown, worktrees?: ListWorktreesInput, stillOwns?: () => boolean): Promise<void>;
  refreshFromSession(): Promise<void>;
  commitView(): void;
};

export type HerdOperationOptions<T> = {
  owner?: OperationOwner;
  capability?: OperationCapability;
  conflictMessage?: string;
  after?: (result: T, owner: OperationOwner) => Promise<void>;
  reconcileWorktrees?: ListWorktreesInput;
  noticeScope?: NoticeScope;
};

function stillOwns(owner: OperationOwner, ports: MutationRunnerPorts): boolean {
  return ownsOperationView(owner, ports, ports.currentLive(), ports.currentDaemonId());
}

/** The irreversible send gate: owner, own prompt lock and advertised capability. */
function canSend(owner: OperationOwner, capability: OperationCapability | undefined, ports: MutationRunnerPorts): boolean {
  return stillOwns(owner, ports) && (!capability || ports.capabilityEnabled(capability));
}

export async function runHerdOperation<T>(
  pending: string,
  success: string,
  action: () => Promise<T>,
  ports: MutationRunnerPorts,
  options: HerdOperationOptions<T> = {},
): Promise<void> {
  const session = ports.currentLive();
  if (ports.busy() || !session || !ports.connected()) return;
  const owner = options.owner ?? operationOwner(session, ports.currentIncarnation(), ports.currentViewVersion());
  if (!stillOwns(owner, ports) || (options.capability && !ports.capabilityEnabled(options.capability))) return;
  const lockId = ports.acquirePromptLock();
  if (lockId === null) return;
  owner.lockId = lockId;
  const { after, reconcileWorktrees } = options;
  const noticeScope = options.noticeScope ?? owner.scope;
  showStatus(pending, true, noticeScope);
  const pendingNotice = noticesStore.get().notice;
  const clearPendingNotice = () => {
    if (noticesStore.get().notice === pendingNotice) clearNoticeForScope(noticeScope);
  };
  ports.commitView();
  // Final pre-send boundary. The pending-notice publication and the paint can
  // reenter: a subscriber may have switched the live session, revoked the
  // advertised capability or taken the prompt lock. Revalidate owner, own lock
  // and capability together immediately before the irreversible action, and
  // clean up only this operation's notice and lock.
  if (!canSend(owner, options.capability, ports)) {
    clearPendingNotice();
    ports.releasePromptLock(lockId);
    return;
  }
  try {
    const result = await action();
    if (!stillOwns(owner, ports)) return;
    if (after) await after(result, owner);
    else await ports.refreshFromSession();
    if (stillOwns(owner, ports)) showStatus(success, false, options.noticeScope ?? owner.scope);
    else clearPendingNotice();
  } catch (error) {
    await ports.reconcile(owner.session, error, reconcileWorktrees, () => stillOwns(owner, ports));
    if (stillOwns(owner, ports)) {
      const message = error instanceof ProtocolError && error.code === "conflict" && options.conflictMessage
        ? options.conflictMessage : messageOf(error);
      showError(message, noticeScope);
    }
    else clearPendingNotice();
  } finally {
    if (!stillOwns(owner, ports)) clearPendingNotice();
    const released = ports.releasePromptLock(owner.lockId!);
    if (released && ownsComputer(owner, ports.currentLive(), ports.currentDaemonId())) ports.commitView();
  }
}

export async function reportOwnedError(
  owner: OperationOwner,
  error: unknown,
  ports: MutationRunnerPorts,
): Promise<void> {
  await ports.reconcile(owner.session, error, undefined, () => stillOwns(owner, ports));
  if (!stillOwns(owner, ports)) return;
  showError(messageOf(error), owner.scope);
  ports.commitView();
}

export { operationOwner, ownsComputer, ownsOperationView, type OperationOwner };
