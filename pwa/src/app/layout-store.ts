import { computeLayout, layoutsEqual, type LayoutDescriptor, type LayoutInput } from "./layout";
import { currentLayoutInput, publishedLayoutInput } from "./layout-input";
import { capabilitiesStore } from "../features/operations/capabilities-store";
import { connectionStore } from "../features/connection/connection-store";
import { dashboardStore } from "../features/dashboard/catalog-store";
import { navigationStore } from "./navigation-store";
import { preferencesStore } from "../features/settings/preferences-store";
import { sessionStore } from "../features/session/session-store";
import { hasPendingComposition } from "./domain-publication";
import { createDomain, detach, type Immutable } from "../shared/model/domain-store";

/**
 * The composition as derived state.
 *
 * Which page the application shows, and the shell that goes with it, follow from
 * the domains that own phase, screen, session mode, the open pane, the herd list,
 * terminal metrics and the busy marker. The commit pipeline refreshes it from
 * live owner reads; a mounted follower refreshes it from published snapshots so
 * a typed busy/font action updates the shell without re-running frame
 * preparation, and without exposing a staged composition that has not committed.
 *
 * Canonical layout stays private. Every public read, return value and follower
 * callback is the frozen published snapshot.
 */

type LayoutRecord = { layout: LayoutDescriptor | null };

const layoutInputs = [
  connectionStore, navigationStore, sessionStore, dashboardStore, preferencesStore, capabilitiesStore,
] as const;

const layoutDomain = createDomain<LayoutRecord>("app-layout", { layout: null });
export const layoutStore = layoutDomain.store;
const { read, write } = layoutDomain.controller;

export function subscribeLayout(listener: () => void): () => void {
  return layoutStore.subscribe(listener);
}

/** The published composition; null before the first refresh. Frozen. */
export function publishedLayout(): Immutable<LayoutDescriptor> | null {
  return layoutStore.get().layout;
}

/** Published composition for readers that used to ask for the live record. */
export function getLayout(): Immutable<LayoutDescriptor> | null {
  return publishedLayout();
}

function publishComputed(input: LayoutInput): { layout: Immutable<LayoutDescriptor>; changed: boolean } {
  const next = computeLayout(input);
  const changed = !layoutsEqual(read().layout, next);
  if (changed) {
    write((record) => {
      record.layout = detach(next);
    });
  }
  const published = layoutStore.get().layout;
  return { layout: published ?? Object.freeze(next), changed };
}

/**
 * Recompute the composition from live owner reads and publish it when it changed.
 * The commit pipeline uses this: it is about to publish those reads.
 */
export function refreshLayout(): Immutable<LayoutDescriptor> {
  return publishComputed(currentLayoutInput()).layout;
}

/**
 * Recompute from published snapshots. A follower uses this so unpublished staged
 * composition fields cannot select a page the frame has not committed.
 */
export function refreshPublishedLayout(): { layout: Immutable<LayoutDescriptor>; changed: boolean } {
  return publishComputed(publishedLayoutInput());
}

let followGeneration = 0;
let inputReleases: Array<() => void> = [];
let layoutListener: ((layout: Immutable<LayoutDescriptor>) => void) | null = null;

function stopFollowing(): void {
  layoutListener = null;
  for (const release of inputReleases) release();
  inputReleases = [];
}

/**
 * Follow the input domains so a typed action recomposes without a paint.
 * Binding again replaces the previous follow. The returned release only retires
 * the binding it acquired.
 */
export function followLayoutInputs(
  onChange?: (layout: Immutable<LayoutDescriptor>) => void,
): () => void {
  stopFollowing();
  const generation = ++followGeneration;
  layoutListener = onChange ?? null;
  inputReleases = layoutInputs.map((store) => store.subscribe(() => {
    if (generation !== followGeneration) return;
    if (hasPendingComposition()) return;
    const { layout, changed } = refreshPublishedLayout();
    if (changed) layoutListener?.(layout);
  }));
  return () => {
    if (generation !== followGeneration) return;
    followGeneration += 1;
    stopFollowing();
  };
}

/** Drop the derived composition (teardown, fixtures). */
export function resetLayout(): void {
  write((record) => {
    record.layout = null;
  });
}
