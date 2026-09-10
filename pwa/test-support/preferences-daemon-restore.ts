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
 * Narrow preferences-specific capture/restore for the four daemon-scoped maps
 * (paneTouched, panePinned, paneTermModes, paneComposeLive) and their raw
 * storage keys. Use it where a fixture seeds a real snapshot
 * (`applySnapshot`/`replaceAgentsFromSnapshot`), which legitimately prunes
 * per-pane preferences for panes the snapshot no longer reports; the cleanup
 * must give those maps/raw keys back exactly, leaving other storage alone.
 *
 * The daemon-scoped keys + preimages are captured together (the active daemon
 * at capture owns the storage), and restore() rewrites the raw preimages on the
 * real storage, then feeds the captured canonical maps to the existing
 * `adoptDaemonPreferences` through a fixture-local forwarding localStorage
 * Proxy that intercepts `getItem` for exactly those four keys (JSON), restoring
 * the global descriptor in finally. Foreign panes, the memory/storage
 * distinction and external subscribers are preserved.
 */
export class DaemonPreferenceState {
  private keys: { touched: string; pinned: string; terms: string; compose: string } = {
    touched: "", pinned: "", terms: "", compose: "",
  };
  private raws: { touched: string | null; pinned: string | null; terms: string | null; compose: string | null } = {
    touched: null, pinned: null, terms: null, compose: null,
  };
  private maps: {
    touched: Record<string, unknown>;
    pinned: Record<string, unknown>;
    terms: Record<string, unknown>;
    compose: Record<string, unknown>;
  } = { touched: {}, pinned: {}, terms: {}, compose: {} };

  capture(): void {
    const scope = daemonId();
    this.keys = {
      touched: `${PANE_TOUCHED_KEY}:${scope}`,
      pinned: `${PANE_PINNED_KEY}:${scope}`,
      terms: `${PANE_TERM_MODE_KEY}:${scope}`,
      compose: `${PANE_COMPOSE_LIVE_KEY}:${scope}`,
    };
    for (const name of ["touched", "pinned", "terms", "compose"] as const) {
      this.raws[name] = localStorage.getItem(this.keys[name]);
    }
    const current = preferencesStore.get();
    this.maps = {
      touched: { ...current.paneTouched },
      pinned: { ...current.panePinned },
      terms: { ...current.paneTermModes },
      compose: { ...current.paneComposeLive },
    };
  }

  restore(): void {
    const real = globalThis.localStorage;
    for (const name of ["touched", "pinned", "terms", "compose"] as const) {
      const key = this.keys[name];
      const raw = this.raws[name];
      if (raw === null) real.removeItem(key);
      else real.setItem(key, raw);
    }
    const reads = new Map<string, string>([
      [this.keys.touched, JSON.stringify(this.maps.touched)],
      [this.keys.pinned, JSON.stringify(this.maps.pinned)],
      [this.keys.terms, JSON.stringify(this.maps.terms)],
      [this.keys.compose, JSON.stringify(this.maps.compose)],
    ]);
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const proxy = new Proxy(real, {
      get(target: Storage, prop: PropertyKey, receiver: unknown): unknown {
        if (prop === "getItem") {
          return (key: string): string | null => {
            const intercepted = reads.get(key);
            return intercepted === undefined ? target.getItem(key) : intercepted;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: proxy });
    try {
      adoptDaemonPreferences();
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
}