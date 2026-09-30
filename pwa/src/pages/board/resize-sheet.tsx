import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { currentScreen, navigationStore } from "../../app/navigation-store";
import { showStatus } from "../../app/notices-store";
import { agentTitle } from "../../lib/dashboard";
import { t, type CopyKey } from "../../lib/i18n";
import type { LayoutDirection } from "../../lib/operations";
import { boardStore, liveBoardCatalog } from "../../features/board/layout-store";
import { dividerCells, paneDivider, paneStepMove, type DividerAxis } from "../../features/board/model/divider";
import { computersStore } from "../../features/computers/catalog-store";
import { connectionStore } from "../../features/connection/connection-store";
import { dashboardStore } from "../../features/dashboard/catalog-store";
import { capabilitiesStore } from "../../features/operations/capabilities-store";
import { MenuGroup, MenuSetting, showActionSheet, type ActionSheetController } from "../../shared/ui/overlay";
import { Button } from "../../shared/ui/primitives";
import { createDomainUpdates, useDomainUpdates } from "../domain-updates";
import { boardLayoutReason, boardPaneCard, commitBoardResize, watchBoardTarget } from "./board-layout-ops";

const updates = createDomainUpdates([
  { store: navigationStore }, { store: boardStore }, { store: dashboardStore },
  { store: computersStore }, { store: connectionStore }, { store: capabilitiesStore },
]);

const SIDE: Record<LayoutDirection, CopyKey> = {
  left: "boardMenu.side.left", right: "boardMenu.side.right", up: "boardMenu.side.up", down: "boardMenu.side.down",
};

/**
 * Steppers for one pane, the resize mode of the board. Each step names an axis
 * and a direction of growth; `paneStepMove` turns that into the one herdr
 * request that moves this pane's own divider, so a right-hand or lower pane
 * grows when it says it grows. Values come from the live snapshot after every
 * step; one step runs at a time and nothing is retried.
 */
function BoardResizeSheet({ modal, paneId, target }: {
  modal: ActionSheetController; paneId: string; target: ReturnType<typeof watchBoardTarget>;
}) {
  useDomainUpdates(updates);
  useEffect(() => target.release, [target]);
  const { valid } = target;
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const live = valid();
  useEffect(() => {
    if (!live) queueMicrotask(() => {
      modal.dismiss();
      if (currentScreen() === "board") showStatus(t("boardMenu.targetGone"));
    });
  }, [live, modal]);
  const catalog = liveBoardCatalog();
  const layout = catalog.layouts.find((item) => item.tabId === catalog.tabId) ?? null;
  const rect = layout?.panes.find((pane) => pane.paneId === paneId)?.rect;
  const reason = pending ? t("boardMenu.busy") : boardLayoutReason("resize");

  const step = async (axis: DividerAxis, grow: boolean) => {
    if (running.current || !layout || boardLayoutReason("resize")) return;
    const move = paneStepMove(layout, paneId, axis, grow);
    if (!move) return;
    running.current = true;
    setPending(true);
    try { await commitBoardResize(move.request); } finally { running.current = false; setPending(false); }
  };

  const row = (axis: DividerAxis) => {
    const found = layout && !layout.zoomed ? paneDivider(layout, paneId, axis) : null;
    const size = rect ? (axis === "width" ? rect.width : rect.height) : 0;
    let hint = t(axis === "width" ? "boardMenu.noWidthDivider" : "boardMenu.noHeightDivider");
    if (found) {
      const [first, second] = dividerCells(found.divider);
      const mine = found.side === "right" || found.side === "down" ? first : second;
      hint = t("boardMenu.dividerSide", { side: t(SIDE[found.side]), n: Math.round((mine / Math.max(1, first + second)) * 100) });
    }
    const can = (grow: boolean) => !reason && !!layout && !!found && !!paneStepMove(layout, paneId, axis, grow);
    const label = t(axis === "width" ? "boardMenu.width" : "boardMenu.height");
    return <MenuSetting key={axis} label={label} hint={hint}>
      <div className="menu-stepper" role="group" aria-label={label}>
        <Button className="menu-stepper-btn" aria-label={t(axis === "width" ? "form.narrower" : "form.shorter")}
          disabled={!can(false)} onClick={() => void step(axis, false)}><Minus size={18} aria-hidden="true" /></Button>
        <output className="menu-stepper-value" aria-live="polite">
          {t(axis === "width" ? "boardMenu.cols" : "boardMenu.rows", { n: size })}
        </output>
        <Button className="menu-stepper-btn" aria-label={t(axis === "width" ? "form.wider" : "form.taller")}
          disabled={!can(true)} onClick={() => void step(axis, true)}><Plus size={18} aria-hidden="true" /></Button>
      </div>
    </MenuSetting>;
  };

  return <div className="board-sheet board-resize">
    <MenuGroup>{row("width")}{row("height")}</MenuGroup>
    <p className="create-hint">{t("boardMenu.stepHint")}</p>
    <p className="board-sheet-note" role="status">{reason}</p>
    <Button className="btn btn-primary board-sheet-done" onClick={modal.dismiss}>{t("boardMenu.done")}</Button>
  </div>;
}

/** The stepper sheet for one pane: a tap on a divider, or the pane menu's 调整大小…. */
export function openBoardResizeSheet(paneId: string): void {
  const card = boardPaneCard(paneId);
  if (!card) return;
  const target = watchBoardTarget(paneId, card.tabId ?? "");
  showActionSheet(t("boardMenu.resizeTitle"), (modal) => <BoardResizeSheet modal={modal} paneId={paneId} target={target} />,
    { subtitle: agentTitle(card), className: "board-resize-sheet" });
}
