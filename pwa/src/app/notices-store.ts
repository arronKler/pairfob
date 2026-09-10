import { sameNoticeScope, type NoticeScope } from "../lib/notice-scope";
import { createDomain } from "../shared/model/domain-store";
import { connectionStore, phase } from "../features/connection/connection-store";
import { computersStore, currentDaemonId } from "../features/computers/catalog-store";
import { currentScreen, navigationStore } from "./navigation-store";
import { openPaneId, sessionStore } from "../features/session/session-store";

/**
 * Notice domain: the one scoped toast. It publishes on its own — a toast appears
 * without a page repaint, and its timeout drops it without remounting the pane.
 *
 * A notice carries the scope it was raised in; `visibleNotice` hides it once the
 * reader has navigated away, so a message never follows the reader to another
 * pane, computer or screen.
 */
export type Notice = { text: string; tone: "error" | "status"; scope?: NoticeScope };

export const STATUS_NOTICE_MS = 2800;

export type NoticeRecord = { notice: Notice | null };

const noticesDomain = createDomain<NoticeRecord>("notices", { notice: null });
export const noticesStore = noticesDomain.store;
const { read, write } = noticesDomain.controller;


let noticeTimer: number | null = null;

function stopNoticeTimer(): void {
  if (noticeTimer === null) return;
  window.clearTimeout(noticeTimer);
  noticeTimer = null;
}

/**
 * The scope a notice is raised in. It reads the owning domains' selectors, so a
 * notice consumer that subscribes only to this domain still needs those domains
 * to publish for the scope to change — which they do, because navigation and pane
 * changes are actions.
 */
export function captureNoticeScope(): NoticeScope {
  return Object.freeze({
    phase: phase(),
    screen: currentScreen(),
    daemonId: currentDaemonId(),
    paneId: openPaneId(),
  });
}

export function noticeScopeIsCurrent(scope: NoticeScope): boolean {
  return sameNoticeScope(scope, captureNoticeScope());
}

/**
 * The notice to show. A notice is frozen when the domain adopts it, so this
 * canonical value is safe to hand out and stable enough for
 * `useSyncExternalStore`: the same object until the notice changes.
 */
export function visibleNotice(): Notice | null {
  const notice = read().notice;
  if (!notice?.scope || noticeScopeIsCurrent(notice.scope)) return notice;
  return null;
}

/** A notice and its scope are domain data: adopted detached and frozen. */
function adoptNotice(text: string, tone: Notice["tone"], scope?: NoticeScope): Notice {
  return Object.freeze({
    text,
    tone,
    ...(scope ? { scope: Object.freeze({ ...scope }) } : {}),
  });
}

/** The notice record only. Fires when this domain publishes and nothing else. */
export function subscribeNotice(listener: () => void): () => void {
  return noticesStore.subscribe(listener);
}

/**
 * Subscribe to the notice a consumer actually renders.
 *
 * `visibleNotice` hides a scoped notice once its scope stops being current, and
 * that scope is read from connection (phase), navigation (screen), computers
 * (daemon) and session (pane). Subscribing to this domain alone would leave a
 * stale notice on screen after any of those moved without the notice itself
 * changing, so the visible-notice subscription covers all five. It suppresses
 * redundant notifications: the listener fires only when the visible value
 * actually changed, never for a scope publication that leaves the same notice
 * on screen.
 *
 * This is the application-scoped toast authority. A feature that renders a notice
 * subscribes here rather than assembling the same five-domain subscription
 * itself.
 */
export function subscribeVisibleNotice(listener: () => void): () => void {
  let shown = visibleNotice();
  const onScopeOrNoticeChange = (): void => {
    const next = visibleNotice();
    if (next === shown) return;
    shown = next;
    listener();
  };
  const stops = [noticesStore, connectionStore, navigationStore, computersStore, sessionStore]
    .map((store) => store.subscribe(onScopeOrNoticeChange));
  return () => {
    for (const stop of stops) stop();
  };
}

export function clearNotice(): void {
  stopNoticeTimer();
  write((record) => {
    record.notice = null;
  });
}

export function clearNoticeForScope(scope: NoticeScope): void {
  const raised = read().notice?.scope;
  if (!raised || !sameNoticeScope(raised, scope)) return;
  clearNotice();
}

function scheduleNoticeDismiss(text: string, tone: Notice["tone"]): void {
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null;
    const current = read().notice;
    if (current?.tone !== tone || current.text !== text) return;
    write((record) => {
      record.notice = null;
    });
  }, STATUS_NOTICE_MS);
}

/** Landing-page errors pass `true` so the copy stays until the next action. */
export function showError(text: string, scopeOrPersist?: NoticeScope | boolean, persist = false): void {
  stopNoticeTimer();
  const scope = typeof scopeOrPersist === "object" && scopeOrPersist ? scopeOrPersist : undefined;
  const keep = typeof scopeOrPersist === "boolean" ? scopeOrPersist : persist;
  write((record) => {
    record.notice = adoptNotice(text, "error", scope);
  });
  if (keep || !text) return;
  scheduleNoticeDismiss(text, "error");
}

export function showStatus(text: string, persist = false, scope?: NoticeScope): void {
  stopNoticeTimer();
  write((record) => {
    record.notice = adoptNotice(text, "status", scope);
  });
  if (persist || !text) return;
  scheduleNoticeDismiss(text, "status");
}

/** Test/QA teardown: drop the pending timeout without publishing. */
export function disposeNoticeLifecycle(): void {
  stopNoticeTimer();
}
