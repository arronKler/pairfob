/**
 * TEMPORARY board scroll bridge.
 *
 * A board drag can scroll a remote pane. That crosses three owners: the session
 * (the guided-scroll controller that keeps a TTY read honest), the daemon read
 * that refreshes the thumbnail afterwards, and the debounce that keeps a fling
 * from firing one read per line. This module is the seam; the gesture adapter
 * only reports direction and line count.
 *
 * The session and the pane's reported viewport come from the domains that own
 * them (`computers.liveSession()`, `dashboardStore`); this hot path never
 * publishes, so it reads what the last commit published.
 */
import { liveSession } from "../../features/computers/catalog-store";
import { dashboardStore } from "../../features/dashboard/catalog-store";
import type { TabLayout } from "../../lib/layout";
import { scrollGridForPane } from "../../features/board/model/gesture";
import { guidedScrollController } from "../../features/session/guided/guided-scroll";
import { refreshBoardPanePreview } from "../../features/board/preview/refresh";

/** A finished scroll earns one thumbnail, not one per delivered line batch. */
const PREVIEW_AFTER_SCROLL_MS = 120;

let previewTimer: number | null = null;
let previewPane = "";

export function schedulePanePreview(paneId: string): void {
  previewPane = paneId;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    const id = previewPane;
    previewPane = "";
    if (id) void refreshBoardPanePreview(id);
  }, PREVIEW_AFTER_SCROLL_MS);
}

/** Retire the remote scroll controller and any thumbnail it had queued. */
export function releaseBoardScroll(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = null;
  previewPane = "";
  guidedScrollController.dispose();
}

/**
 * Scroll one pane of the bound layout. Resolves false when there is nothing to
 * scroll or the daemon refused; the caller then asks for no thumbnail.
 */
export function scrollBoardPane(
  layout: TabLayout,
  paneId: string,
  direction: "up" | "down",
  lines: number,
): Promise<boolean> {
  const session = liveSession();
  if (!session?.isConnected() || !paneId || lines < 1) return Promise.resolve(false);
  const agent = dashboardStore.get().agents.find((item) => item.paneId === paneId);
  const grid = scrollGridForPane(layout, paneId, agent?.viewportRows);
  return guidedScrollController.scroll(
    { session, paneId, cols: grid.cols, rows: grid.rows },
    direction,
    lines,
  ).then(
    (applied) => applied === true,
    () => false,
  );
}
