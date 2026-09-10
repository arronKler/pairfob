/**
 * Domain store primitive (framework-neutral).
 *
 * One store per named domain. A domain owns a mutable record, publishes frozen
 * snapshot copies for React, and notifies only its own subscribers. There is no
 * deep mutation proxy and no application-wide revision counter.
 *
 * This module is shared infrastructure: it imports no React, no DOM, no App, no
 * feature and no screen. A feature domain module and the App publication layer
 * build on it; nothing here reaches back into them.
 *
 * Ownership contract
 * - `createDomain` returns a public `store` and an owner-only `controller`. The
 *   controller is module-private in the domain file: `controller.write()` is the
 *   only mutation path, and `controller.read()` is the coherent live read an
 *   action needs. Neither the record nor a writable alias of it is reachable
 *   from the store, so no other module can change a domain behind its back.
 * - Other domains and components use the domain's exported selectors, actions
 *   and `store.get()` snapshots.
 * - `get()` returns the published snapshot: a deep-frozen copy of the plain data
 *   the domain owns. A published snapshot never changes under a reader, so it can
 *   be held, compared and memoized.
 * - Opaque handles are declared per domain (`opaque: ["live"]`), by ownership
 *   contract rather than by prototype: a `LiveSession` is a live resource whose
 *   identity callers compare, whether production hands over a class instance or a
 *   fixture hands over an object literal. Declared handles are shared by identity
 *   and never copied or frozen.
 * - Any other non-plain value (class instance, `Map`, `Set`, typed array) is
 *   treated as a foreign handle too: shared, not frozen, because freezing a `Map`
 *   would not freeze its entries. Data a domain owns and publishes must be plain
 *   objects and arrays; a domain that must hold a collection exposes selectors
 *   instead of putting the collection in a snapshot.
 * - An action that adopts caller-owned data detaches it (`detach`), so a caller
 *   keeping the original cannot change published domain state without an action.
 *
 * `batch()` defers notifications so one commit that touches several domains
 * publishes a coherent transaction and renders React once.
 *
 * A staged composition write is a publication barrier for *that domain*:
 * `write` / `writeIf` on a store that has `stage()` pending do not update the
 * published snapshot until a publication transaction. Ordinary writes on other
 * domains still update `get()` immediately; `batch()` only defers notifications.
 * Chat merge (`applyTrace` then `chatSnapshot`) depends on that split: a
 * composition hold on session/navigation/connection must not feed the previous
 * transcript page. A merge that must see a staged composition field uses the
 * owner `controller.read()`, not `store.get()` — do not silently publish a
 * staged domain through `get()` to keep a later reader current.
 */

export type DomainListener = () => void;
export type Unsubscribe = () => void;

/** Values a snapshot shares by identity instead of copying and freezing. */
type Opaque =
  | ((...args: never[]) => unknown)
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | Date
  | RegExp
  | Error
  | Promise<unknown>
  | ArrayBuffer
  | ArrayBufferView;

/** Deep read-only view of a record; opaque handles keep their own shape. */
export type Immutable<T> = T extends Opaque
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [K in keyof T]: Immutable<T[K]> }
      : T;

/**
 * How a record looks from outside its owner: every field read-only, plain data
 * deeply frozen, and declared handles keeping the type they were adopted with.
 */
export type DomainView<Data extends object, Opaque extends keyof Data = never> =
  { readonly [K in Exclude<keyof Data, Opaque>]: Immutable<Data[K]> }
  & { readonly [K in Opaque]: Data[K] };

export type DomainStore<Data extends object, Opaque extends keyof Data = never> = {
  /** Stable name for diagnostics and tests. */
  readonly name: string;
  /** Published snapshot for React: deep-frozen, stable until the next publish. */
  get(): DomainView<Data, Opaque>;
  subscribe(listener: DomainListener): Unsubscribe;
  /** Publish the record as it stands. The commit pipeline calls this. */
  publish(): void;
  isDirty(): boolean;
  /** True while a staged composition write is waiting for its commit. */
  isCompositionPending(): boolean;
};

/**
 * Owner-only handle. A domain module keeps this private: no other module can
 * reach the record, so no other module can change a domain behind its back.
 */
export type DomainController<Data extends object, Opaque extends keyof Data = never> = {
  /** The live record, for coherent reads inside this domain's actions. */
  read(): DomainView<Data, Opaque>;
  /** The only write path: mutate the record, then publish (or join a batch). */
  write(mutate: (record: Data) => void): void;
  /**
   * Mutate the record and leave publication to the next commit. A composition
   * change uses this so its domain snapshot and the composition it selects are
   * published in the same transaction, instead of a subscriber seeing the new
   * value one render before the page it selects. `store.get()` stays on the last
   * published snapshot until that transaction; action-time reads use `read()`.
   */
  stage(mutate: (record: Data) => void): void;
  /**
   * Decide inside the mutation whether anything changed, and publish only then.
   * An action that turns out to be a no-op must not notify subscribers.
   */
  writeIf(mutate: (record: Data) => boolean): boolean;
};

export type DomainOptions<Data extends object> = {
  /** Record keys holding opaque handles: shared by identity, never copied. */
  opaque?: readonly (keyof Data & string)[];
};

let batchDepth = 0;
/**
 * Publication transactions. A staged composition write must reach subscribers
 * together with the composition it selects, so while a domain holds one, only a
 * caller that opens a transaction (the commit pipeline, a headless compose
 * transaction, or a fixture flush) may publish that domain.
 */
let transactionDepth = 0;
/** How many stores currently hold a staged composition write. */
let compositionHolds = 0;
const pending = new Set<() => void>();

/** Open a publication transaction: staged composition writes may publish. */
export function beginPublicationTransaction(): void {
  transactionDepth += 1;
}

export function endPublicationTransaction(): void {
  if (transactionDepth === 0) return;
  transactionDepth -= 1;
}

export function inPublicationTransaction(): boolean {
  return transactionDepth > 0;
}

/**
 * True while at least one store has a staged composition write that has not
 * joined a publication transaction yet. Layout derivation skips live unpublished
 * composition fields in that window.
 */
export function compositionPublicationHeld(): boolean {
  return compositionHolds > 0 && transactionDepth === 0;
}

function publicationHeld(storePending: boolean): boolean {
  if (transactionDepth > 0) return false;
  return storePending;
}

function schedule(notify: () => void): void {
  if (batchDepth > 0) {
    pending.add(notify);
    return;
  }
  notify();
}

/**
 * Collect notifications from every store touched inside `body` and flush them
 * once at the end, so subscribers only ever observe a complete transaction.
 */
export function batch<T>(body: () => T): T {
  batchDepth += 1;
  try {
    return body();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) flushNotifications();
  }
}

/**
 * Open a batch whose notifications the caller flushes itself. The commit pipeline
 * uses this to publish every domain, prepare the frame and apply the shell before
 * deciding whether the render is synchronous.
 */
export function suspendNotifications(): void {
  batchDepth += 1;
}

/** Close a suspended batch without flushing; pair with `flushNotifications`. */
export function resumeNotifications(): void {
  if (batchDepth === 0) return;
  batchDepth -= 1;
}

/** Fire the notifications an open batch collected. */
export function flushNotifications(): void {
  if (batchDepth > 0) return;
  if (!pending.size) return;
  const queued = [...pending];
  pending.clear();
  for (const notify of queued) notify();
}

export function batching(): boolean {
  return batchDepth > 0;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Copy plain data key by key with explicit own-property definitions.
 *
 * Assignment into a fresh `{}` would lose an own `__proto__` key holding a
 * primitive, and would re-parent the copy when it holds an object. Defining own
 * properties keeps arbitrary dictionary keys — including `__proto__` — as data,
 * and `Object.create(proto)` keeps an intentional null prototype.
 */
function copyOwn(source: object, freeze: boolean, opaqueKeys: ReadonlySet<string>): object {
  const proto = Object.getPrototypeOf(source) as object | null;
  const target: Record<string, unknown> = Object.create(proto) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    Object.defineProperty(target, key, {
      value: opaqueKeys.has(key) ? value : copyValue(value, freeze),
      enumerable: true,
      writable: !freeze,
      configurable: true,
    });
  }
  return freeze ? Object.freeze(target) : target;
}

/**
 * `opaqueKeys` applies to this level only: a record's declared foreign handles
 * are shared, while everything nested underneath is copied as data.
 */
function copyValue(value: unknown, freeze: boolean, opaqueKeys: ReadonlySet<string> = EMPTY_KEYS): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => copyValue(item, freeze));
    return freeze ? Object.freeze(items) : items;
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    return copyOwn(value, freeze, opaqueKeys);
  }
  // Primitives and foreign values (class instances, Map/Set, typed arrays) are
  // returned as they are: copying them would break identity or their internals.
  return value;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Deep-frozen snapshot copy of a record; declared opaque keys keep identity. */
export function immutableCopy<Data extends object>(
  record: Data,
  opaqueKeys: readonly string[] = [],
): Immutable<Data> {
  return copyValue(record, true, new Set(opaqueKeys)) as Immutable<Data>;
}

/**
 * Detach caller-owned plain data before a domain adopts it. Opaque handles keep
 * their identity, so a live session is never cloned.
 */
export function detach<T>(value: T): T {
  return copyValue(value, false) as T;
}

function retainCompositionHold(pending: boolean): boolean {
  if (pending) return true;
  compositionHolds += 1;
  return true;
}

function releaseCompositionHold(pending: boolean): boolean {
  if (!pending) return false;
  compositionHolds = Math.max(0, compositionHolds - 1);
  return false;
}

export function createDomain<Data extends object, Opaque extends keyof Data = never>(
  name: string,
  initial: Data,
  options: DomainOptions<Data> = {},
): { store: DomainStore<Data, Opaque>; controller: DomainController<Data, Opaque> } {
  const record = initial;
  const opaqueKeys = [...(options.opaque ?? [])];
  let snapshot = immutableCopy(record, opaqueKeys) as DomainView<Data, Opaque>;
  let dirty = false;
  let compositionPending = false;
  const listeners = new Set<DomainListener>();

  function notify(): void {
    if (!listeners.size) return;
    for (const listener of [...listeners]) listener();
  }

  function publish(): void {
    if (publicationHeld(compositionPending)) {
      dirty = true;
      return;
    }
    compositionPending = releaseCompositionHold(compositionPending);
    dirty = false;
    snapshot = immutableCopy(record, opaqueKeys) as DomainView<Data, Opaque>;
    schedule(notify);
  }

  const store: DomainStore<Data, Opaque> = {
    name,
    get: () => snapshot,
    subscribe(listener: DomainListener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish,
    isDirty: () => dirty,
    isCompositionPending: () => compositionPending,
  };

  const controller: DomainController<Data, Opaque> = {
    // The owner reads its live record; the view type keeps plain data read-only
    // and leaves declared handles as the handles they are.
    read: () => record as DomainView<Data, Opaque>,
    write(mutate: (record: Data) => void): void {
      mutate(record);
      if (publicationHeld(compositionPending)) {
        dirty = true;
        return;
      }
      publish();
    },
    stage(mutate: (record: Data) => void): void {
      mutate(record);
      dirty = true;
      compositionPending = retainCompositionHold(compositionPending);
    },
    writeIf(mutate: (record: Data) => boolean): boolean {
      if (!mutate(record)) return false;
      if (publicationHeld(compositionPending)) {
        dirty = true;
        return true;
      }
      publish();
      return true;
    },
  };

  return { store, controller };
}
