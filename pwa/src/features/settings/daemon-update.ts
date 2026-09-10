import { ProtocolError } from "../../lib/protocol/errors";
import { parseUpdateStatus, updateInProgress, type UpdateStatus } from "../../lib/daemon-update-status";
import type { LiveSession } from "../../lib/protocol/session-types";
import { newerRelease, legacyBuild, releaseParts } from "../../lib/daemon-version";
import { currentDaemonId, liveSession } from "../computers/catalog-store";
export type DaemonVersion = { build: string; latest: string; error: boolean; checkedManually?: boolean; incompatible?: boolean; status?: UpdateStatus; uncertain?: boolean; requesting?: boolean; rejected?: boolean };
const views = new Map<string, DaemonVersion>();
let nextCheckAt = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let observing = false;
const listeners = new Set<() => void>();
let revision = 0;
export function daemonUpdateRevision(): number { return revision; }
export function subscribeDaemonUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifyUpdate(): void {
  revision++;
  for (const listener of listeners) listener();
}
/**
 * Whether the browser observer/scheduler lifecycle can run. Headless pure
 * ownership tests import this chain without a DOM; absent a browser there are
 * no document/window callbacks or timers to install. The one-shot release
 * fetch and a directly awaited status read are still allowed without a
 * browser; only the periodic observer scheduling (visibility/focus listener,
 * release re-check timer, status poll) becomes a no-op.
 */
function browserLifecycleAvailable(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function scheduleReleaseCheck(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (!browserLifecycleAvailable()) return;
  if (document.visibilityState === "hidden" || !currentDaemonId()) return;
  releaseTimer = setTimeout(() => { releaseTimer = null; void checkDaemonRelease(); }, Math.max(1000, nextCheckAt - Date.now()));
}
export function observeDaemonUpdates(): void {
  if (observing) return;
  // No browser to observe (headless): do not install any listener or timer and
  // leave observing false so a later browser environment can still install.
  if (!browserLifecycleAvailable()) return;
  observing = true;
  const resume = () => {
    if (document.visibilityState === "hidden") {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      if (poll) clearTimeout(poll);
      poll = null;
      return;
    }
    if (!currentDaemonId()) return;
    void checkDaemonRelease();
    void refreshDaemonUpdate();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
}
export function markDaemonConfigIncompatible(): void {
  const view = daemonVersion();
  if (view) view.incompatible = true;
  notifyUpdate();
}
let releaseState: "idle" | "checking" | "success" | "error" = "idle";
export function daemonReleaseCheckState(): typeof releaseState { return releaseState; }
let latest = "";
let flight: Promise<void> | null = null;
export function daemonVersion(): DaemonVersion | undefined { return views.get(currentDaemonId() || ""); }
export function needsDaemonUpdate(view = daemonVersion()): boolean {
  return !!view && (view.incompatible || legacyBuild(view.build) || newerRelease(view.latest, view.build));
}
export function acceptDaemonVersion(config: unknown): void {
  observeDaemonUpdates();
  const id = currentDaemonId();
  if (!id) return;
  if (!views.has(id) && views.size >= 32) {
    const evict = [...views].find(([,v]) => !v.requesting && !v.uncertain && !updateInProgress(v.status));
    if (!evict) return;
    views.delete(evict[0]);
  }
  const view = views.get(id) || { build: "", latest, error: false };
  const build = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).build : undefined;
  view.build = typeof build === "string" && build.length <= 256 ? build : "";
  view.incompatible = false;
  views.set(id, view);
  void refreshDaemonUpdate();
  void checkDaemonRelease();
}
export async function checkDaemonRelease(force = false): Promise<void> {
  if (flight) return flight;
  observeDaemonUpdates();
  if (!force && Date.now() < nextCheckAt) { scheduleReleaseCheck(); return; }
  releaseState = "checking";
  flight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/dl/VERSION", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("release unavailable");
      const value = (await response.text()).trim();
      if (!releaseParts(value)) throw new Error("invalid release version");
      releaseState = "success";
      latest = value;
      nextCheckAt = Date.now() + 6 * 60 * 60 * 1000;
      for (const view of views.values()) { view.latest = value; view.error = false; }
    } catch {
      releaseState = "error";
      nextCheckAt = Date.now() + 60 * 1000;
      for (const view of views.values()) view.error = true;
    }
    finally {
      clearTimeout(timer); flight = null;
      scheduleReleaseCheck();
      notifyUpdate();
    }
  })();
  notifyUpdate();
  return flight;
}

let statusFlight: Promise<void> | null = null;
let statusSession: LiveSession | null = null;
let poll: ReturnType<typeof setTimeout> | null = null;
export async function refreshDaemonUpdate(): Promise<void> {
  const session = liveSession(), id = currentDaemonId();
  if (!session?.daemonUpdateStatus || !session.isConnected() || !id) return;
  if (statusFlight && statusSession === session) return statusFlight;
  statusSession = session;
  const task = (async () => {
    try {
      const result = parseUpdateStatus(await session.daemonUpdateStatus!());
      if (liveSession() !== session || currentDaemonId() !== id) return;
      const view = views.get(id);
      if (view) {
        view.status = result;
        // A status read does not prove a lost update request was rejected.
        if (result.operation_id && result.target === view.latest && (updateInProgress(result) || result.phase === "complete")) view.uncertain = false;
        if (result.phase === "complete") {
          const config = await session.getConfig();
          if (liveSession() === session && typeof config.build === "string") view.build = config.build;
        }
      }
    } catch { /* Old daemons return unknown_op; keep the manual update path. */ }
    finally {
      if (liveSession() === session && currentDaemonId() === id) {
        notifyUpdate();
        if (poll) clearTimeout(poll);
        if (browserLifecycleAvailable() && document.visibilityState !== "hidden" && (updateInProgress(views.get(id)?.status) || views.get(id)?.uncertain)) poll = setTimeout(() => { poll = null; void refreshDaemonUpdate(); }, 3000);
      }
    }
  })();
  statusFlight = task;
  try { await task; } finally { if (statusFlight === task) statusFlight = null; }
}
/**
 * The captured owner may dispatch its one update RPC. Narrows the session to a
 * connected one exposing the update RPC. The requesting flag is checked
 * separately at the call sites: this is re-evaluated *after* setting it, across
 * the requesting publication, so it must not include that flag.
 */
function updateDispatchReady(session: LiveSession | null, view: DaemonVersion | undefined): session is LiveSession {
  return !!session && !!session.daemonUpdate && session.isConnected() && !!view && !!view.status?.available
    && !view.incompatible && !legacyBuild(view.build) && !view.uncertain
    && !updateInProgress(view.status) && needsDaemonUpdate(view);
}

export async function startDaemonUpdate(): Promise<void> {
  const session = liveSession(), id = currentDaemonId(), view = daemonVersion();
  if (!id || !view || view.requesting || !updateDispatchReady(session, view)) return;
  view.requesting = true;
  view.rejected = false;
  notifyUpdate();
  // The requesting publication is an observable boundary: a subscriber may
  // switch to another computer/session or flag this build incompatible.
  // Revalidate the captured owner and eligibility immediately before the
  // mutation so a retired or ineligible attempt dispatches no RPC — exactly
  // one normal update call, never a replay. An attempt cancelled before
  // dispatch releases only its own requesting state.
  const ownerStable = liveSession() === session && currentDaemonId() === id && daemonVersion() === view;
  if (!ownerStable || !updateDispatchReady(session, view)) {
    view.requesting = false;
    if (currentDaemonId() === id) notifyUpdate();
    return;
  }
  try {
    const result = parseUpdateStatus(await session.daemonUpdate!(view.latest));
    if (liveSession() === session && currentDaemonId() === id) view.status = result;
  } catch (error) {
    view.rejected = error instanceof ProtocolError && ["conflict", "invalid_argument", "unknown_op", "rate_limited", "not_connected", "disconnected"].includes(error.code);
    view.uncertain = !view.rejected;
  }
  finally {
    view.requesting = false;
    if (currentDaemonId() === id) {
      notifyUpdate();
      void refreshDaemonUpdate();
    }
  }
}
