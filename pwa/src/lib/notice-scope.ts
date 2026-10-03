export type NoticeScope = {
  phase: string;
  screen: string;
  daemonId: string | null;
  /** Herdr session on that computer; absent or null is the default session. */
  herdSession?: string | null;
  paneId: string;
};

export function sameNoticeScope(left: NoticeScope, right: NoticeScope): boolean {
  return (
    left.phase === right.phase &&
    left.screen === right.screen &&
    left.daemonId === right.daemonId &&
    (left.herdSession ?? null) === (right.herdSession ?? null) &&
    left.paneId === right.paneId
  );
}
