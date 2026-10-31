/**
 * The last herd list this page painted for a computer, kept for its next switch.
 *
 * Switching back to a computer the page already holds a pooled session for needs
 * no handshake, so the only wait left is the GetConfig and Snapshot read that
 * follows. Keeping the painted projection hands the target's rows to the tap's
 * own turn; the ordinary refresh supersedes them in the background. A cache, not
 * state: nothing is published, the entries are bounded, and a view only answers
 * for the credential and Herdr session it was read from (pane ids repeat across
 * computers and sessions). A full page load starts with none.
 */
import type { PairResult } from "../../lib/protocol/client";
import { computersStore, currentDaemonId, liveSession } from "../computers/catalog-store";
import {
  adoptDashboardProjection,
  dashboardProjection,
  type DashboardProjection,
} from "../dashboard/catalog-store";
import { applyRuntimeIdentity, runtimeStore } from "./runtime-store";

export type RetainedView = {
  daemonId: string;
  deviceId: string;
  fingerprint: string;
  /** The Herdr session the rows were read from; pane ids repeat across sessions. */
  herdSession: string | null;
  dashboard: DashboardProjection;
  identity: { herdHost: string; runtimeKind: string };
  takenAt: number;
};

/** Bounded like the session pool: a view is useful only while its session is pooled. */
const MAX_RETAINED_VIEWS = 3;
const views = new Map<string, RetainedView>();

/** Keep the connected computer's painted list before a switch retires it. */
export function retainLiveView(): void {
  const session = liveSession();
  const daemonId = currentDaemonId();
  const credential = computersStore.get().credential;
  if (!session || !daemonId || !credential || credential.daemonId !== daemonId) return;
  const dashboard = dashboardProjection();
  // An unread list would replace a painted one with placeholder rows.
  if (!dashboard.snapshotLoaded) return;
  const { herdHost, runtimeKind } = runtimeStore.get();
  views.delete(daemonId);
  views.set(daemonId, {
    daemonId,
    deviceId: credential.deviceId,
    fingerprint: credential.fp,
    herdSession: session.herdSession?.() ?? null,
    dashboard,
    identity: { herdHost, runtimeKind },
    takenAt: Date.now(),
  });
  while (views.size > MAX_RETAINED_VIEWS) {
    const oldest = views.keys().next().value;
    if (typeof oldest !== "string") break;
    views.delete(oldest);
  }
}

/** The kept view for a switch to `pair` whose session targets `herdSession`. */
export function retainedViewFor(
  pair: Pick<PairResult, "daemonId" | "deviceId" | "fp">,
  herdSession: string | null,
): RetainedView | null {
  const view = matching(pair, herdSession);
  // A view that no longer answers for this credential belongs to a computer
  // this page no longer holds; the next switch reads it fresh anyway.
  if (!view) views.delete(pair.daemonId);
  return view;
}

/**
 * Whether a switch would paint this computer's kept view, for a picker that
 * names the switches that need no round trip. A query: nothing is dropped.
 */
export function hasRetainedView(
  pair: Pick<PairResult, "daemonId" | "deviceId" | "fp">,
  herdSession: string | null,
): boolean {
  return matching(pair, herdSession) !== null;
}

function matching(
  pair: Pick<PairResult, "daemonId" | "deviceId" | "fp">,
  herdSession: string | null,
): RetainedView | null {
  const view = views.get(pair.daemonId);
  if (!view) return null;
  const sameOwner = view.deviceId === pair.deviceId && view.fingerprint === pair.fp;
  return sameOwner && view.herdSession === herdSession ? view : null;
}

/** Adopt a kept view. False and no write unless the credential already names its daemon. */
export function adoptRetainedView(view: RetainedView): boolean {
  if (currentDaemonId() !== view.daemonId) return false;
  adoptDashboardProjection(view.dashboard);
  applyRuntimeIdentity(view.identity);
  return true;
}

/** A forgotten, burned or evicted computer's view goes with it. */
export function forgetRetainedView(daemonId: string): void {
  views.delete(daemonId);
}

/** Test seam. */
export function resetRetainedViewsForTests(): void {
  views.clear();
}
