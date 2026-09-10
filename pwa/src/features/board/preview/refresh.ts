/**
 * Board preview scheduling (feature-owned).
 *
 * The preview *store* is state-free (`./store.ts`); this module is the only place
 * that decides when the board may read panes: which screen is up, which session
 * is live, which tab layout is current, and how many rows a pane asks for. Reads
 * use the board/dashboard/computers canonical readers and published snapshots — a
 * typed action is visible to them the moment it lands; the App commit pipeline
 * owns publication, so this never flushes. `currentScreen` is a named navigation
 * reader, not the App composition/runtime.
 */
import { liveBoardCatalog } from "../layout-store";
import { liveSession } from "../../computers/catalog-store";
import { networkOnline } from "../../connection/connection-store";
import { liveAgents } from "../../dashboard/catalog-store";
import { currentScreen } from "../../../app/navigation-store";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { layoutForTab, type TabLayout } from "../../../lib/layout";
import { boardPreviewPaneIds, previewLineCount } from "./model";
import {
  enqueuePreviewPass,
  nextPreviewGeneration,
  previewGeneration,
  prunePreviews,
  runPreviewPass,
  type PreviewSource,
} from "./store";

function liveSource(): PreviewSource | null {
  const session = liveSession();
  return session && session.isConnected() ? (session as unknown as PreviewSource) : null;
}

/** The published catalog is frozen and only read by the projection; action-time
 *  pass gating reads the live owner record so a typed action is visible at once. */
function currentLayout(): TabLayout | null {
  const catalog = liveBoardCatalog();
  return layoutForTab(catalog.tabId, catalog.layouts as TabLayout[], liveAgents() as DashboardAgentCard[]);
}

function liveAgentsForLayout(): DashboardAgentCard[] {
  return liveAgents() as DashboardAgentCard[];
}

/** `session` is omitted for the pass-opening check, which only screens token and route. */
function passIsCurrent(token: number, session?: PreviewSource | null): boolean {
  if (token !== previewGeneration() || currentScreen() !== "board") return false;
  return session === undefined || liveSession() === session;
}

function linesFor(layout: TabLayout | null, paneId: string): number {
  const pane = layout?.panes.find((item) => item.paneId === paneId);
  const agent = liveAgentsForLayout().find((item) => item.paneId === paneId);
  return previewLineCount(agent?.viewportRows, pane?.rect.height);
}

/** One pane, after a scroll the daemon applied. Never supersedes a pass. */
export function refreshBoardPanePreview(paneId: string): Promise<void> {
  if (!paneId || currentScreen() !== "board") return Promise.resolve();
  const session = liveSource();
  if (!session || !networkOnline() || document.visibilityState === "hidden") return Promise.resolve();
  const layout = currentLayout();
  if (!layout?.panes.some((item) => item.paneId === paneId)) return Promise.resolve();
  const token = previewGeneration();
  return runPreviewPass({
    ids: [paneId],
    linesOf: (id) => linesFor(layout, id),
    source: session,
    alive: () => passIsCurrent(token, session),
  });
}

/**
 * Serial pane.read of the visible tab. Later calls supersede an in-flight pass.
 */
export function refreshBoardPreviews(): Promise<void> {
  const token = nextPreviewGeneration();
  return enqueuePreviewPass(async () => {
    if (!passIsCurrent(token)) return;
    const session = liveSource();
    if (!session || !networkOnline() || document.visibilityState === "hidden") return;
    const layout = currentLayout();
    prunePreviews(liveAgentsForLayout().map((agent) => agent.paneId));
    await runPreviewPass({
      ids: boardPreviewPaneIds(layout),
      linesOf: (id) => linesFor(layout, id),
      source: session,
      alive: () => passIsCurrent(token, session),
    });
  });
}