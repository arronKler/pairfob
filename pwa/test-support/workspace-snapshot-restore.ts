import { COMPLETION_SEEN_KEY, captureDashboardProjection, dashboardStore, reloadCompletionSeen, setRefreshBusy, type DashboardRecord } from "../src/features/dashboard/catalog-store";
import { captureBoardProjection } from "../src/features/board/layout-store";
import { currentDaemonId, currentDeviceId } from "../src/features/computers/catalog-store";
import {
  PANE_COMPOSE_LIVE_KEY,
  PANE_PINNED_KEY,
  PANE_TERM_MODE_KEY,
  PANE_TOUCHED_KEY,
  adoptDaemonPreferences,
  preferencesStore,
  type PreferencesRecord,
} from "../src/features/settings/preferences-store";

/**
 * Workspace-snapshot fixture restore (narrow, dashboard/preferences scope).
 *
 * A workspace fixture seeds the herd through `replaceAgentsFromSnapshot`, which
 * (besides cards) projects completion attention and prunes pane pins and pane
 * preferences, persisting the pruned maps back to the daemon-scoped storage.
 * Non-owned values a previous consumer installed (a foreign completion
 * acknowledgement, a foreign pin, a foreign pane choice, refreshBusy) must
 * survive the fixture's own catalog lifecycle.
 *
 * Canonical maps and raw keys are captured separately and restored separately —
 * never derived from the other:
 * - the canonical maps (paneTouched/panePinned/paneTermModes/paneComposeLive,
 *   dashboard completionSeen) and refreshBusy are captured from the published
 *   snapshots before the seed;
 * - the exact raw preimage of every daemon-scoped storage key is captured too.
 *
 * Restore writes the raw preimages back to the real storage, then replays the
 * captured canonical maps through the existing named adopt/reload APIs with a
 * fixture-local forwarding `localStorage.getItem` proxy that supplies exactly
 * those captured maps (JSON), and restores the original global descriptor in
 * finally. `setRefreshBusy(prior)` is the named field boundary. Not a generic
 * TestState bag; nothing else is read or written.
 *
 * Capture is strictly per-capture: the raw preimage map is cleared before each
 * capture (a later daemon scope never rewrites earlier keys), and restore clears
 * the bookkeeping after replay so a later no-seed pure case cannot replay a
 * previous case's snapshot.
 */
const seenScoped = (): string => `${COMPLETION_SEEN_KEY}:${currentDaemonId() || "anon"}:${currentDeviceId() || "anon"}`;
const paneScoped = (prefix: string): string => `${prefix}:${currentDaemonId() || "anon"}`;

function exposeItemReads(real: Storage, reads: Map<string, string>): () => void {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const proxy = new Proxy(real, {
    get(target: Storage, prop: PropertyKey, receiver: unknown): unknown {
      if (prop === "getItem") {
        return (key: string): string | null => {
          const intercepted = (reads as Map<string, string>).get(key);
          return intercepted === undefined ? target.getItem(key) : intercepted;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: proxy });
  return () => {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

export class WorkspaceSnapshotRestorer {
  private captured = false;
  private touchedKey = "";
  private pinnedKey = "";
  private termModeKey = "";
  private composeKey = "";
  private seenKey = "";
  private raw = new Map<string, string | null>();
  private touched: PreferencesRecord["paneTouched"] = {};
  private pinned: PreferencesRecord["panePinned"] = {};
  private termModes: PreferencesRecord["paneTermModes"] = {};
  private compose: PreferencesRecord["paneComposeLive"] = {};
  private seen: DashboardRecord["completionSeen"] = {};
  private refreshBusy = false;
  private dashboardRestore: (() => void) | null = null;
  private boardRestore: (() => void) | null = null;

  /** Capture canonical maps AND raw preimages at the active daemon scope. */
  capture(): void {
    this.raw.clear();
    this.touchedKey = paneScoped(PANE_TOUCHED_KEY);
    this.pinnedKey = paneScoped(PANE_PINNED_KEY);
    this.termModeKey = paneScoped(PANE_TERM_MODE_KEY);
    this.composeKey = paneScoped(PANE_COMPOSE_LIVE_KEY);
    this.seenKey = seenScoped();
    const allKeys = [this.touchedKey, this.pinnedKey, this.termModeKey, this.composeKey, this.seenKey];
    for (const key of allKeys) this.raw.set(key, localStorage.getItem(key));
    const prefs = preferencesStore.get();
    this.touched = { ...prefs.paneTouched };
    this.pinned = { ...prefs.panePinned };
    this.termModes = { ...prefs.paneTermModes };
    this.compose = { ...prefs.paneComposeLive };
    this.seen = { ...dashboardStore.get().completionSeen };
    this.refreshBusy = dashboardStore.get().refreshBusy;
    this.dashboardRestore = captureDashboardProjection();
    this.boardRestore = captureBoardProjection();
    this.captured = true;
  }

  /** Restore raw preimages, then replay captured maps via the named APIs. */
  restore(): void {
    if (!this.captured) return;
    const real = globalThis.localStorage;
    this.dashboardRestore?.();
    this.boardRestore?.();
    this.dashboardRestore = null;
    this.boardRestore = null;
    for (const [key, value] of this.raw) {
      if (value === null) real.removeItem(key);
      else real.setItem(key, value);
    }
    const reads = new Map<string, string>([
      [this.touchedKey, JSON.stringify(this.touched)],
      [this.pinnedKey, JSON.stringify(this.pinned)],
      [this.termModeKey, JSON.stringify(this.termModes)],
      [this.composeKey, JSON.stringify(this.compose)],
      [this.seenKey, JSON.stringify(this.seen)],
    ]);
    const restoreLocalStorage = exposeItemReads(real, reads);
    try {
      adoptDaemonPreferences();
      reloadCompletionSeen();
    } finally {
      restoreLocalStorage();
    }
    setRefreshBusy(this.refreshBusy);
    // One lifecycle only: a later no-seed pure case must not replay this case.
    this.captured = false;
    this.raw.clear();
    this.touched = {};
    this.pinned = {};
    this.termModes = {};
    this.compose = {};
    this.seen = {};
    this.refreshBusy = false;
  }
}