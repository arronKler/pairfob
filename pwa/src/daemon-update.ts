import { ProtocolError } from "./lib/protocol/errors";
import { parseUpdateStatus, updateInProgress, type UpdateStatus } from "./lib/daemon-update-status";
import type { LiveSession } from "./lib/protocol/session-types";
import { newerRelease, legacyBuild, releaseParts } from "./lib/daemon-version";
import { state } from "./state";
import { render } from "./paint";
export type DaemonVersion = { build: string; latest: string; error: boolean; checkedManually?: boolean; incompatible?: boolean; status?: UpdateStatus; uncertain?: boolean; requesting?: boolean; rejected?: boolean };
const views = new Map<string, DaemonVersion>();
let nextCheckAt = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let observing = false;
let repaint = () => { if (state.screen === "settings" || state.screen === "home") render(); };
export function setDaemonUpdateRenderer(callback: () => void): void { repaint = callback; }
function scheduleReleaseCheck(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (document.visibilityState === "hidden" || !state.credential) return;
  releaseTimer = setTimeout(() => { releaseTimer = null; void checkDaemonRelease(); }, Math.max(1000, nextCheckAt - Date.now()));
}
export function observeDaemonUpdates(): void {
  if (observing) return;
  observing = true;
  const resume = () => {
    if (document.visibilityState === "hidden") {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      if (poll) clearTimeout(poll);
      poll = null;
      return;
    }
    if (!state.credential) return;
    void checkDaemonRelease();
    void refreshDaemonUpdate();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
}
export function markDaemonConfigIncompatible(): void {
  const view = daemonVersion();
  if (view) view.incompatible = true;
  repaint();
}
let releaseState: "idle" | "checking" | "success" | "error" = "idle";
export function daemonReleaseCheckState(): typeof releaseState { return releaseState; }
let latest = "";
let flight: Promise<void> | null = null;
export function daemonVersion(): DaemonVersion | undefined { return views.get(state.credential?.daemonId || ""); }
export function needsDaemonUpdate(view = daemonVersion()): boolean {
  return !!view && (view.incompatible || legacyBuild(view.build) || newerRelease(view.latest, view.build));
}
export function acceptDaemonVersion(config: unknown): void {
  observeDaemonUpdates();
  const id = state.credential?.daemonId;
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
      repaint();
    }
  })();
  repaint();
  return flight;
}

let statusFlight: Promise<void> | null = null;
let statusSession: LiveSession | null = null;
let poll: ReturnType<typeof setTimeout> | null = null;
export async function refreshDaemonUpdate(): Promise<void> {
  const session = state.live, id = state.credential?.daemonId;
  if (!session?.daemonUpdateStatus || !session.isConnected() || !id) return;
  if (statusFlight && statusSession === session) return statusFlight;
  statusSession = session;
  const task = (async () => {
    try {
      const result = parseUpdateStatus(await session.daemonUpdateStatus!());
      if (state.live !== session || state.credential?.daemonId !== id) return;
      const view = views.get(id);
      if (view) {
        view.status = result;
        // A status read does not prove a lost update request was rejected.
        if (result.operation_id && result.target === view.latest && (updateInProgress(result) || result.phase === "complete")) view.uncertain = false;
        if (result.phase === "complete") {
          const config = await session.getConfig();
          if (state.live === session && typeof config.build === "string") view.build = config.build;
        }
      }
    } catch { /* Old daemons return unknown_op; keep the manual update path. */ }
    finally {
      if (state.live === session && state.credential?.daemonId === id) {
        repaint();
        if (poll) clearTimeout(poll);
        if (document.visibilityState !== "hidden" && (updateInProgress(views.get(id)?.status) || views.get(id)?.uncertain)) poll = setTimeout(() => { poll = null; void refreshDaemonUpdate(); }, 3000);
      }
    }
  })();
  statusFlight = task;
  try { await task; } finally { if (statusFlight === task) statusFlight = null; }
}
export async function startDaemonUpdate(): Promise<void> {
  const session = state.live, id = state.credential?.daemonId, view = daemonVersion();
  if (!id || !view || !session?.daemonUpdate || !session.isConnected() || !view.status?.available || view.incompatible || legacyBuild(view.build) || view.requesting || view.uncertain || updateInProgress(view.status) || !needsDaemonUpdate(view)) return;
  view.requesting = true;
  view.rejected = false;
  render();
  try {
    const result = parseUpdateStatus(await session.daemonUpdate(view.latest));
    if (state.live === session && state.credential?.daemonId === id) view.status = result;
  } catch (error) {
    view.rejected = error instanceof ProtocolError && ["conflict", "invalid_argument", "unknown_op", "rate_limited", "not_connected", "disconnected"].includes(error.code);
    view.uncertain = !view.rejected;
  }
  finally {
    view.requesting = false;
    if (state.credential?.daemonId === id) {
      repaint();
      void refreshDaemonUpdate();
    }
  }
}
