/**
 * Board layout operations.
 *
 * The canvas, the pane menu and the sheets all change the computer's layout
 * through these few calls. Each one resolves the target to the board tab's
 * pane card at action time, gates on the live connection, the operation lock
 * and the advertised capability, and hands a target-validity check to the
 * operation so a result that lands after the reader moved on changes nothing
 * on screen. The request shape (which pane, which way) comes from
 * `features/board/model/divider.ts`; nothing here decides herdr directions.
 */
import { currentScreen, navigationStore } from "../../app/navigation-store";
import { showStatus } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import type { DashboardAgentCard } from "../../lib/dashboard";
import type { LayoutDirection, ResizePaneInput } from "../../lib/operations";
import { boardStore, liveBoardCatalog } from "../../features/board/layout-store";
import { liveSession } from "../../features/computers/catalog-store";
import { networkOnline } from "../../features/connection/connection-store";
import { dashboardStore, liveAgents } from "../../features/dashboard/catalog-store";
import { capabilityEnabled, operationBusy } from "../../features/operations/capabilities-store";
import { closePane, layoutSelectedPane, renamePane } from "../../features/operations/controller";
import type { BoardLayoutKind } from "../../features/board/components/board-canvas";

export type { BoardLayoutKind };

/** The board tab's card for a pane, or null once it left the tab on screen. */
export function boardPaneCard(paneId: string): DashboardAgentCard | null {
  const catalog = liveBoardCatalog();
  return (liveAgents() as DashboardAgentCard[]).find((card) => card.paneId === paneId
    && card.tabId === catalog.tabId && card.workspaceId === catalog.workspaceId) ?? null;
}

/** A target stays valid while its pane is still on the tab the board is showing. */
export function stillOnBoard(paneId: string, tabId: string): () => boolean {
  return () => currentScreen() === "board" && liveBoardCatalog().tabId === tabId && !!boardPaneCard(paneId);
}

/**
 * A sheet's target lifetime: once the pane left the board tab it stays gone,
 * even if the reader switches back before the sheet acts, so a pending form
 * can never land on a tab the reader already left. Departures are observed on
 * every board, dashboard and navigation publish; `release` ends the watch.
 */
export function watchBoardTarget(paneId: string, tabId: string): { valid: () => boolean; release: () => void } {
  const check = stillOnBoard(paneId, tabId);
  let gone = false;
  const valid = () => !(gone ||= !check());
  const stops = [boardStore, dashboardStore, navigationStore].map((store) => store.subscribe(() => { valid(); }));
  return { valid, release: () => { for (const stop of stops) stop(); } };
}

/** Why no command can run right now: the connection or the operation lock. */
export function boardCommandReason(): string {
  if (liveSession()?.isConnected() !== true || !networkOnline()) return t("boardMenu.offline");
  return operationBusy() ? t("boardMenu.busy") : "";
}

export function boardLayoutReason(kind: BoardLayoutKind): string {
  const blocked = boardCommandReason();
  if (blocked) return blocked;
  const capability = kind === "resize" ? "resize_pane" : kind === "swap" ? "swap_pane" : kind === "split" ? "split_pane" : "zoom_pane";
  if (!capabilityEnabled(capability)) return t("boardMenu.unavailable");
  const catalog = liveBoardCatalog();
  const layout = catalog.layouts.find((item) => item.tabId === catalog.tabId);
  if ((kind === "resize" || kind === "swap") && layout?.zoomed) return t("boardMenu.zoomedReason");
  if ((kind === "resize" || kind === "swap") && (!layout || layout.panes.length < 2)) return t("boardMenu.singleReason");
  return "";
}

/**
 * The pane a gesture or key released on, if the commit may still run. A refusal
 * that appeared mid-gesture (the pane left, the link dropped, another operation
 * started) says why instead of snapping back silently.
 */
function commitTarget(paneId: string, kind: BoardLayoutKind): DashboardAgentCard | null {
  const card = boardPaneCard(paneId);
  const reason = card ? boardLayoutReason(kind) : t("boardMenu.targetGone");
  if (reason) { showStatus(reason); return null; }
  return card;
}

export async function commitBoardResize(request: ResizePaneInput): Promise<void> {
  const card = commitTarget(request.pane_id, "resize");
  if (!card) return;
  await layoutSelectedPane("resize", card, { valid: stillOnBoard(card.paneId, card.tabId ?? ""),
    choice: { kind: "resize", direction: request.direction, amount: request.amount ?? 0.05 } });
}

export async function commitBoardSwap(paneId: string, direction: LayoutDirection): Promise<void> {
  const card = commitTarget(paneId, "swap");
  if (!card) return;
  await layoutSelectedPane("swap", card, { valid: stillOnBoard(card.paneId, card.tabId ?? ""), choice: { kind: "swap", direction } });
}

export async function toggleBoardZoom(paneId: string, mode: "on" | "off"): Promise<void> {
  const card = commitTarget(paneId, "zoom");
  if (!card) return;
  await layoutSelectedPane("zoom", card, { valid: stillOnBoard(card.paneId, card.tabId ?? ""), zoomMode: mode });
}

export function boardPaneAction(paneId: string, action: "rename" | "close"): void {
  const card = boardPaneCard(paneId);
  if (!card || boardCommandReason()) return;
  const options = { valid: stillOnBoard(card.paneId, card.tabId ?? "") };
  void (action === "rename" ? renamePane(card, options) : closePane(card, options));
}
