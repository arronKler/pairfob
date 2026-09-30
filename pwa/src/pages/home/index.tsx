import { useSyncExternalStore } from "react";
import { capabilitiesStore } from "../../features/operations/capabilities-store";
import { computersStore } from "../../features/computers/catalog-store";
import { connectionStore } from "../../features/connection/connection-store";
import { dashboardStore } from "../../features/dashboard/catalog-store";
import { preferencesStore } from "../../features/settings/preferences-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import { sessionStore } from "../../features/session/session-store";
import { boardStore, type BoardRecord } from "../../features/board/layout-store";
import { navigationStore } from "../../app/navigation-store";
import { createHerdActions } from "../../features/dashboard/actions";
import { HerdScreen } from "../../features/dashboard/components/herd-screen";
import { buildHerdViewModel, type HerdViewModel } from "../../features/dashboard/model/herd-view";
import { createDomainUpdates, useDomainUpdates, type DomainWatch } from "../domain-updates";
import { herdActionPorts, readHerdAttention, readHerdInput, subscribeHerdAttention } from "./herd-bridge";

/**
 * Home route: the phone page and the desktop rail.
 *
 * The route subscribes to the domains whose data the herd list renders, so a
 * typed action — a fold, a pin, a snapshot fold, a capability change — updates a
 * mounted list without anyone calling `render()`. Attention is not part of that:
 * it is consumed once per presentation by the bridge and published as a stable
 * snapshot, which keeps the haptic and the change sweep out of React's render.
 *
 * The route takes no props. The imperative boundaries that still consume
 * attention before a presentation — core's per-commit frame
 * (`app/frame-prepare.ts`) and the edge-swipe underlay
 * (`features/session/guided/pane-underlay.tsx`) — call `presentHerdView()` once:
 * the bridge consumes attention and reconciles the accordion defaults, and this
 * route renders the same pure projection over the same domains. One source of
 * truth, and a typed action updates the mounted list whether or not anything
 * repaints.
 */
const watches: DomainWatch[] = [
  { store: dashboardStore },
  { store: preferencesStore },
  { store: capabilitiesStore },
  { store: connectionStore },
  { store: computersStore },
  { store: runtimeStore },
  { store: sessionStore },
  // The desk rail marks the board's tab and its own Board link. Keyed on the tab
  // so camera writes at pointer speed never re-render the list.
  { store: navigationStore, keyOf: (snapshot) => (snapshot as { screen: string }).screen },
  { store: boardStore, keyOf: (snapshot) => (snapshot as BoardRecord).boardTabId },
];

const updates = createDomainUpdates(watches);
const actions = createHerdActions(herdActionPorts());

function useHerdView(): HerdViewModel {
  const painted = useSyncExternalStore(subscribeHerdAttention, readHerdAttention);
  useDomainUpdates(updates);
  return buildHerdViewModel(readHerdInput(painted));
}

/** Sessions that wait on the reader or finished unread; the tab bar badge. */
export function useHerdAttentionCount(): number {
  const view = useHerdView();
  return view.attention.length;
}

export function HomePage() {
  return <HerdScreen view={useHerdView()} actions={actions} variant="page" />;
}

export function HomeRail() {
  return <HerdScreen view={useHerdView()} actions={actions} variant="rail" />;
}
