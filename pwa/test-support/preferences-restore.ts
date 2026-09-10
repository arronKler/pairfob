import {
  PANE_COMPOSE_LIVE_KEY,
  PANE_PINNED_KEY,
  PANE_TERM_MODE_KEY,
  PANE_TOUCHED_KEY,
  adoptDaemonPreferences,
  preferencesStore,
} from "../src/features/settings/preferences-store";
import { daemonId } from "../src/features/computers/catalog-store";

/**
 * Preferences-specific teardown for leaf fixtures that persist one pane's
 * compose choice (full-terminal compose suites).
 *
 * The compose mode cases go through `setFullTerminalInputMode` -> the real
 * `setPaneComposeLive('p1', ...)`, so both the in-memory `paneComposeLive` map
 * and its daemon-scoped raw storage key change. Restoring by reloading all four
 * daemon-scoped maps from storage (`adoptDaemonPreferences`) is wrong: it would
 * also resurrect `paneTouched` / `panePinned` values that a prior consumer
 * (e.g. Home's `resetHerdPresentationChoices`) intentionally cleared in memory
 * while leaving them persisted. So this helper restores maps and raw keys
 * separately:
 *
 * - capture the raw compose preimage and the owned p1 own/value from the
 *   published preferences snapshot before the case;
 * - at cleanup keep the CURRENT published touched/pinned/term-modes maps and the
 *   current compose map with ONLY p1 restored to its captured own/absent/value;
 * - restore the raw compose preimage on the real storage and never touch the
 *   other three raw keys;
 * - feed those intended in-memory maps to the existing `adoptDaemonPreferences`
 *   through a fixture-local forwarding `localStorage` Proxy whose `getItem`
 *   intercepts exactly the four daemon-scoped keys (JSON) and forwards/binds
 *   everything else, then restore the global descriptor in finally.
 *
 * No production setter/reset API is added and foreign panes / external
 * subscribers survive. Not a generic TestState bag.
 */

const scoped = (prefix: string): string => `${prefix}:${daemonId()}`;

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

export class PaneComposePreferenceRestorer {
  private composeKey = "";
  private touchedKey = "";
  private pinnedKey = "";
  private termModeKey = "";
  private rawPreimage: string | null = null;
  private paneOwned = false;
  private paneValue = false;

  /**
   * Capture the daemon-scoped keys AND the preimages now: the active daemon at
   * capture() owns the storage, which can differ from construction time (the
   * helper is reused across suites). Restore uses exactly this captured scope.
   */
  capture(paneId: string): void {
    this.composeKey = scoped(PANE_COMPOSE_LIVE_KEY);
    this.touchedKey = scoped(PANE_TOUCHED_KEY);
    this.pinnedKey = scoped(PANE_PINNED_KEY);
    this.termModeKey = scoped(PANE_TERM_MODE_KEY);
    this.rawPreimage = localStorage.getItem(this.composeKey);
    const map = { ...preferencesStore.get().paneComposeLive };
    this.paneOwned = Object.prototype.hasOwnProperty.call(map, paneId);
    this.paneValue = map[paneId];
  }

  /** Restore maps + raw after the case: p1 compose choice only; foreign kept. */
  restore(paneId: string): void {
    const real = globalThis.localStorage;
    const current = preferencesStore.get();
    const intendedCompose = { ...current.paneComposeLive };
    if (this.paneOwned) intendedCompose[paneId] = this.paneValue;
    else delete intendedCompose[paneId];
    const reads = new Map<string, string>([
      [this.touchedKey, JSON.stringify(current.paneTouched)],
      [this.pinnedKey, JSON.stringify(current.panePinned)],
      [this.termModeKey, JSON.stringify(current.paneTermModes)],
      [this.composeKey, JSON.stringify(intendedCompose)],
    ]);
    if (this.rawPreimage === null) real.removeItem(this.composeKey);
    else real.setItem(this.composeKey, this.rawPreimage);
    const restoreLocalStorage = exposeItemReads(real, reads);
    try {
      adoptDaemonPreferences();
    } finally {
      restoreLocalStorage();
    }
  }
}