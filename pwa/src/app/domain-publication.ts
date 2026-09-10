import { batch, beginPublicationTransaction, endPublicationTransaction, flushNotifications,
  inPublicationTransaction, type DomainStore, type Unsubscribe } from "../shared/model/domain-store";
import { boardStore } from "../features/board/layout-store";
import { capabilitiesStore } from "../features/operations/capabilities-store";
import { chatStore } from "../features/session/chat/trace-store";
import { composeStore } from "../features/session/compose-store";
import { computersStore } from "../features/computers/catalog-store";
import { connectionStore } from "../features/connection/connection-store";
import { dashboardStore } from "../features/dashboard/catalog-store";
import { navigationStore } from "./navigation-store";
import { noticesStore } from "./notices-store";
import { pairingStore } from "../features/pairing/form-store";
import { preferencesStore } from "../features/settings/preferences-store";
import { runtimeStore } from "../features/connection/runtime-store";
import { sessionStore } from "../features/session/session-store";

/**
 * App domain publication.
 *
 * The App is the composition owner: it is the only place that publishes staged
 * domain writes as one transaction around frame preparation and the shell. This
 * module owns the concrete, ordered collection of every application domain and
 * the pending-publication operations the commit pipeline drives. Domains own
 * their own records and actions; this module never reaches a record.
 *
 * The store order is a publication order, not a dependency claim. Domains read
 * each other through exported selectors and owner actions, and the module graph
 * stays acyclic.
 */
export type AnyDomainStore = DomainStore<object, never>;

export const domainStores: readonly AnyDomainStore[] = Object.freeze([
  connectionStore,
  computersStore,
  pairingStore,
  navigationStore,
  preferencesStore,
  composeStore,
  chatStore,
  sessionStore,
  boardStore,
  dashboardStore,
  noticesStore,
  runtimeStore,
  capabilitiesStore,
]);

export const domainNames: readonly string[] = domainStores.map((store) => store.name);

/**
 * Publish every domain with a pending (dirty or staged) write since the last
 * publish. Returns the domain names published, for diagnostics and tests.
 *
 * One transaction: every pending domain is published before any subscriber runs,
 * so an observer never sees a half-updated application. The publication
 * transaction is what releases a staged composition write.
 */
export function publishPendingDomains(): string[] {
  const published: string[] = [];
  beginPublicationTransaction();
  try {
    batch(() => {
      for (const store of domainStores) {
        if (!store.isDirty()) continue;
        store.publish();
        published.push(store.name);
      }
    });
  } finally {
    endPublicationTransaction();
  }
  return published;
}

/** Compatibility alias: the pending-publication flush under its historical name. */
export const flushDirtyDomains = publishPendingDomains;

/** True when a facade write is waiting for a publish. */
export function hasDirtyDomains(): boolean {
  return domainStores.some((store) => store.isDirty());
}

/** True when a named application domain still holds a staged composition write. */
export function hasPendingComposition(): boolean {
  return domainStores.some((store) => store.isCompositionPending()) && !inPublicationTransaction();
}

/** Publish every domain, dirty or not. Fixture/QA setup and teardown. */
export function publishAllDomains(): void {
  beginPublicationTransaction();
  try {
    batch(() => {
      for (const store of domainStores) store.publish();
    });
  } finally {
    endPublicationTransaction();
  }
}

/**
 * Temporary bridge: subscribe to every domain at once.
 *
 * Screens that still read the `state` facade cannot know which domains they
 * depend on. Migrated components subscribe to one domain instead. Tests use this
 * to assert that a facade write notifies exactly once per touched domain.
 *
 * Retirement is M2, after the last facade subscriber migrates to a named domain.
 */
export function subscribeAllDomains(listener: () => void): Unsubscribe {
  const releases = domainStores.map((store) => store.subscribe(listener));
  return () => {
    for (const release of releases) release();
  };
}

export { batch, flushNotifications };
