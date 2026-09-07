import type { NoticeScope } from "./notice-scope";

/** Compose surfaces that keep their own unsent text for one pane. */
export type ComposeInputMode = "guided" | "agent" | "full";

/** In-memory draft identity: computer + pane + input surface. Never persisted. */
export type ComposeDraftScope = {
  daemonId: string | null;
  paneId: string;
  mode: ComposeInputMode;
};

export function composeDraftKey(scope: ComposeDraftScope): string {
  return `${scope.daemonId ?? ""}\0${scope.paneId}\0${scope.mode}`;
}

export function sameComposeDraftScope(left: ComposeDraftScope, right: ComposeDraftScope): boolean {
  return left.daemonId === right.daemonId && left.paneId === right.paneId && left.mode === right.mode;
}

export function composeDraftScopeFromNotice(notice: NoticeScope, mode: ComposeInputMode): ComposeDraftScope {
  return { daemonId: notice.daemonId, paneId: notice.paneId, mode };
}
