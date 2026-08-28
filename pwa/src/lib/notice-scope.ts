export type NoticeScope = {
  phase: string;
  screen: string;
  daemonId: string | null;
  paneId: string;
};

export function sameNoticeScope(left: NoticeScope, right: NoticeScope): boolean {
  return (
    left.phase === right.phase &&
    left.screen === right.screen &&
    left.daemonId === right.daemonId &&
    left.paneId === right.paneId
  );
}
