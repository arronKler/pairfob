import type { NoticeScope } from "./notice-scope";

/** Compose surfaces that keep their own unsent text for one pane. */
export type ComposeInputMode = "guided" | "agent" | "full";

/**
 * In-memory draft identity: computer + Herdr session + pane + input surface.
 * Pane ids repeat across Herdr sessions, so the session is part of the key.
 * Never persisted.
 */
export type ComposeDraftScope = {
  daemonId: string | null;
  /** Absent or null is the default Herdr session. */
  herdSession?: string | null;
  paneId: string;
  mode: ComposeInputMode;
};

export function composeDraftKey(scope: ComposeDraftScope): string {
  return `${scope.daemonId ?? ""}\0${scope.herdSession ?? ""}\0${scope.paneId}\0${scope.mode}`;
}

export function sameComposeDraftScope(left: ComposeDraftScope, right: ComposeDraftScope): boolean {
  return left.daemonId === right.daemonId && (left.herdSession ?? null) === (right.herdSession ?? null) &&
    left.paneId === right.paneId && left.mode === right.mode;
}

export function composeDraftScopeFromNotice(notice: NoticeScope, mode: ComposeInputMode): ComposeDraftScope {
  return { daemonId: notice.daemonId, herdSession: notice.herdSession ?? null, paneId: notice.paneId, mode };
}
