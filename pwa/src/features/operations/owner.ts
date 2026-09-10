/**
 * Operation owner: the session, notice scope, view incarnation and optional
 * prompt lock captured before a mutation. Delayed confirmation or error cannot
 * target a new computer.
 */
import { liveSession, currentDaemonId } from "../computers/catalog-store";
import { captureNoticeScope, noticeScopeIsCurrent } from "../../app/notices-store";
import type { NoticeScope } from "../../lib/notice-scope";
import type { LiveSession } from "../../lib/protocol/session-types";

export type OperationOwner = {
  session: LiveSession;
  scope: NoticeScope;
  incarnation: number;
  viewVersion: number;
  lockId?: number;
};

export type OperationOwnerPorts = {
  currentIncarnation(): number;
  currentViewVersion(): number;
  promptLockHeld(lockId: number): boolean;
};

export function operationOwner(session: LiveSession, incarnation: number, viewVersion: number): OperationOwner {
  return { session, scope: captureNoticeScope(), incarnation, viewVersion };
}

export function ownsComputer(
  owner: OperationOwner,
  current: LiveSession | null = liveSession(),
  daemonId: string | null = currentDaemonId(),
): boolean {
  return current === owner.session && daemonId === owner.scope.daemonId;
}

export function ownsOperationView(
  owner: OperationOwner,
  ports: OperationOwnerPorts,
  current: LiveSession | null = liveSession(),
  daemonId: string | null = currentDaemonId(),
): boolean {
  return ownsComputer(owner, current, daemonId) &&
    owner.incarnation === ports.currentIncarnation() &&
    owner.viewVersion === ports.currentViewVersion() &&
    noticeScopeIsCurrent(owner.scope) &&
    (owner.lockId === undefined || ports.promptLockHeld(owner.lockId));
}
