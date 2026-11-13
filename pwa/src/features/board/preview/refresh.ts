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
 * Bounded pane.read of the visible tab. Later calls supersede an in-flight pass.
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
/** A status hint names one invalidated pane. Keep the full fallback pass intact,
 * and fold pending hints by pane while it drains. A nameless hint still asks
 * for the whole tab through the ordinary fallback owner.
 */
type PreviewHint = { promise: Promise<void>; reading: boolean; again: boolean };
const hinted = new Map<string, PreviewHint>();
export function refreshBoardPreviewHint(paneId: string): Promise<void> {
  const token = previewGeneration();
  const session = liveSource();
  if (!session) return Promise.resolve();
  const key = `${token}\0${paneId}`;
  const pending = hinted.get(key);
  if (pending) {
    // An event after a read began needs one fresh follow-up, not its old answer.
    if (pending.reading) pending.again = true;
    return pending.promise;
  }
  const hint: PreviewHint = { promise: Promise.resolve(), reading: false, again: false };
  hint.promise = enqueuePreviewPass(async () => {
    if (!passIsCurrent(token, session)) return;
    hint.reading = true;
    for (let pass = 0; pass < 2; pass++) {
      hint.again = false;
      await refreshBoardPanePreview(paneId);
      if (!hint.again || !passIsCurrent(token, session)) break;
    }
  }).finally(() => {
    if (hinted.get(key) === hint) hinted.delete(key);
    // Yield to queued full passes before serving a continuing stream of hints.
    if (hint.again && passIsCurrent(token, session)) void refreshBoardPreviewHint(paneId);
  });
  hinted.set(key, hint);
  return hint.promise;
}
