import { sameNoticeScope, type NoticeScope } from "./lib/notice-scope";

export type Notice = { text: string; tone: "error" | "status"; scope?: NoticeScope };

type NoticeState = {
  phase: string;
  screen: string;
  credential: { daemonId: string } | null;
  paneId: string;
  notice: Notice | null;
};

export const STATUS_NOTICE_MS = 2800;

/** Own the scoped toast lifecycle without coupling it to the rest of AppState. */
export function createNoticeLifecycle(state: NoticeState) {
  let noticeTimer: number | null = null;
  const listeners = new Set<() => void>();

  function subscribeNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function stopNoticeTimer(): void {
    if (noticeTimer === null) return;
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }

  function captureNoticeScope(): NoticeScope {
    return {
      phase: state.phase,
      screen: state.screen,
      daemonId: state.credential?.daemonId ?? null,
      paneId: state.paneId,
    };
  }

  function noticeScopeIsCurrent(scope: NoticeScope): boolean {
    return sameNoticeScope(scope, captureNoticeScope());
  }

  function visibleNotice(): Notice | null {
    const notice = state.notice;
    if (!notice?.scope || noticeScopeIsCurrent(notice.scope)) return notice;
    return null;
  }

  function clearNotice(): void {
    stopNoticeTimer();
    state.notice = null;
    notify();
  }

  function clearNoticeForScope(scope: NoticeScope): void {
    if (!state.notice?.scope || !sameNoticeScope(state.notice.scope, scope)) return;
    clearNotice();
  }

  function scheduleNoticeDismiss(text: string, tone: Notice["tone"]): void {
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null;
      if (state.notice?.tone !== tone || state.notice.text !== text) return;
      state.notice = null;
      notify();
    }, STATUS_NOTICE_MS);
  }

  /** Landing-page errors pass `true` so the copy stays until the next action. */
  function showError(text: string, scopeOrPersist?: NoticeScope | boolean, persist = false): void {
    stopNoticeTimer();
    const scope = typeof scopeOrPersist === "object" && scopeOrPersist ? scopeOrPersist : undefined;
    const keep = typeof scopeOrPersist === "boolean" ? scopeOrPersist : persist;
    state.notice = { text, tone: "error", ...(scope ? { scope } : {}) };
    notify();
    if (keep || !text) return;
    scheduleNoticeDismiss(text, "error");
  }

  function showStatus(text: string, persist = false, scope?: NoticeScope): void {
    stopNoticeTimer();
    state.notice = { text, tone: "status", ...(scope ? { scope } : {}) };
    notify();
    if (persist || !text) return;
    scheduleNoticeDismiss(text, "status");
  }

  return {
    captureNoticeScope,
    noticeScopeIsCurrent,
    visibleNotice,
    subscribeNotice,
    clearNotice,
    clearNoticeForScope,
    showError,
    showStatus,
  };
}
