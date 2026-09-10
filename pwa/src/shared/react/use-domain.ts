import { useSyncExternalStore } from "react";
import type { DomainStore, DomainView } from "../model/domain-store";

/**
 * Generic domain snapshot hook.
 *
 * `useDomain(store)` subscribes to exactly one domain and returns its frozen
 * snapshot, so a component re-renders when the data it reads changes — not on
 * every application repaint. This is the framework-neutral primitive: feature
 * hooks (`<feature>/hooks.ts`) and the App navigation/notice hooks call it with
 * the owning store; components never call it with a cross-feature store.
 *
 * It imports only React and the shared store type; it never reaches a feature,
 * a page or the App.
 */
export function useDomain<Data extends object, Opaque extends keyof Data = never>(
  store: DomainStore<Data, Opaque>,
): DomainView<Data, Opaque> {
  return useSyncExternalStore(store.subscribe, store.get);
}
