/**
 * Domain update subscriptions for a page.
 *
 * A page that reads through the temporary bridge still has to know *when* to
 * re-render: these are the local subscriptions that replace "someone called
 * render()". Each watch names one domain and, optionally, a cheap key of the
 * fields the page actually displays — a domain that publishes sixty times a
 * second for a value the page does not render (the board camera) must not
 * re-render it.
 *
 * The snapshot is *derived* from the watched domains on every read, not counted
 * from notifications. A notification counter only knows about publishes it heard,
 * so a write that lands between a component's render and its passive subscribe —
 * a layout effect on the way in, for example — would be missed and the page would
 * keep showing the value it rendered with. Deriving the key from the domains
 * closes that window: React re-reads the snapshot right after subscribing, sees a
 * different key, and re-renders. Derivation is memoized, so an unchanged world
 * returns the identical snapshot and a camera-only publish stays invisible.
 *
 * The store subscriptions are refcounted: they are installed with the first React
 * subscriber and released with the last, so an unmounted page owns nothing. They
 * are the trigger to look again; correctness does not depend on them. A read of
 * the public snapshot is memoization only: it must not consume a pending
 * notification another subscriber has not yet received.
 */
import { useSyncExternalStore } from "react";
import type { DomainStore } from "../shared/model/domain-store";

export type DomainWatch = {
  store: DomainStore<object>;
  /**
   * Scalar identity of what this page renders from that domain. Omit to react to
   * every publish. Compared with `===`, so it must be a string or number.
   */
  keyOf?: (snapshot: object) => string | number;
};

export type DomainUpdates = {
  subscribe(listener: () => void): () => void;
  /** Derived snapshot token; identical until a watched domain value changes. */
  read(): number;
};

export function createDomainUpdates(watches: DomainWatch[]): DomainUpdates {
  const listeners = new Set<() => void>();
  const releases: Array<() => void> = [];
  // Published snapshots are frozen and replaced on publish, so identity is a
  // publish token for a watch that renders the whole domain.
  const tokens = new WeakMap<object, number>();
  let nextToken = 1;
  // Last derived world a getSnapshot returned. Independent of notifyKey: a
  // read by any observer is memoization, not a consumed notification.
  let readKey: string | null = null;
  // Last derived world notify() compared. A camera-style publish that does not
  // change this stays silent; a read must not advance it.
  let notifyKey: string | null = null;
  let revision = 0;
  let installed: number | null = null;

  function tokenOf(snapshot: object): number {
    const known = tokens.get(snapshot);
    if (known !== undefined) return known;
    const token = nextToken;
    nextToken += 1;
    tokens.set(snapshot, token);
    return token;
  }

  function deriveKey(): string {
    let derived = "";
    for (const watch of watches) {
      const snapshot = watch.store.get();
      derived += `${watch.keyOf ? watch.keyOf(snapshot) : tokenOf(snapshot)}\u0000`;
    }
    return derived;
  }

  function install(): void {
    if (installed !== null) {
      installed += 1;
      return;
    }
    installed = 1;
    // Seed only when nobody has captured yet, so a camera-style first publish is
    // judged against the world at subscribe. A render that already captured a
    // readKey must keep it: overwriting here with the already-new world would
    // hide a write that landed between getSnapshot and subscribe.
    const derived = deriveKey();
    if (readKey === null) readKey = derived;
    if (notifyKey === null) notifyKey = derived;
    for (const watch of watches) {
      releases.push(watch.store.subscribe(notify));
    }
  }

  function release(): void {
    if (installed === null) return;
    installed -= 1;
    if (installed > 0) return;
    installed = null;
    while (releases.length) releases.pop()!();
    notifyKey = null;
  }

  function notify(): void {
    const derived = deriveKey();
    if (notifyKey !== null && derived === notifyKey) return;
    notifyKey = derived;
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      install();
      return () => {
        listeners.delete(listener);
        release();
      };
    },
    read() {
      const derived = deriveKey();
      // Memoized: the same world returns the same token without touching it, so
      // repeated reads during one render are pure and cannot loop. The first read
      // is the baseline, not a change. Advancing readKey never consumes notifyKey.
      if (readKey === null) {
        readKey = derived;
        return revision;
      }
      if (derived === readKey) return revision;
      readKey = derived;
      revision += 1;
      return revision;
    },
  };
}

/** Re-render this component when one of the watched domains publishes. */
export function useDomainUpdates(updates: DomainUpdates): number {
  return useSyncExternalStore(updates.subscribe, updates.read);
}
