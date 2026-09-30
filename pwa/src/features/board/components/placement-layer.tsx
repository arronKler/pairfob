import { useEffect, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { BOARD_CELL_H, BOARD_CELL_W, type LayoutRect, type TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection, SplitDirection } from "../../../lib/operations";
import { t, type CopyKey } from "../../../lib/i18n";
import { boardInteractionStore, endBoardPlacement } from "../interaction-store";
import { swapTargets } from "../model/lift";
import { splitSides } from "../model/placement";
import type { BoardCanvasController } from "./canvas-controller";

const LIFT_LABELS: Record<LayoutDirection, CopyKey> = {
  left: "boardCanvas.liftLeft", right: "boardCanvas.liftRight", up: "boardCanvas.liftUp", down: "boardCanvas.liftDown",
};

function box(layout: TabLayoutView, rect: LayoutRect) {
  return {
    left: (rect.x - layout.area.x) * BOARD_CELL_W,
    top: (rect.y - layout.area.y) * BOARD_CELL_H,
    width: rect.width * BOARD_CELL_W,
    height: rect.height * BOARD_CELL_H,
  };
}
const px = (value: { left: number; top: number; width: number; height: number }) =>
  ({ left: `${value.left}px`, top: `${value.top}px`, width: `${value.width}px`, height: `${value.height}px` });

/**
 * Placement mode, started from the pane menu: pick where a split goes, or which
 * neighbour to swap with. It is modal on the stage (a tap anywhere else, the
 * banner's Cancel or Escape leaves it) and it ends on its own when the tab
 * changes or the pane is gone. Picking a split side hands over to the split
 * sheet through `controller.pickSplit`; picking a neighbour swaps.
 */
export function PlacementLayer({ layout, controller, viewportRef }: {
  layout: TabLayoutView;
  controller: BoardCanvasController;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const interaction = useSyncExternalStore(boardInteractionStore.subscribe, boardInteractionStore.get);
  const kind = interaction.placementKind;
  const paneId = interaction.placementPaneId;
  const target = layout.panes.find((pane) => pane.paneId === paneId);
  const valid = !!kind && !!target && interaction.tabId === layout.tabId && !layout.zoomed;

  useEffect(() => {
    if (kind && !valid) endBoardPlacement();
  }, [kind, valid]);
  useEffect(() => {
    if (!valid) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      endBoardPlacement();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [valid]);

  if (!valid || !target) return null;
  const others = layout.panes.filter((pane) => pane.paneId !== paneId);
  const neighbours = kind === "swap" ? swapTargets(layout, paneId) : new Map<string, LayoutDirection>();
  const sides = splitSides(layout, paneId);
  const rect = box(layout, target.rect);

  const pickSplit = (direction: SplitDirection) => {
    endBoardPlacement();
    controller.pickSplit(paneId, direction);
  };
  const pickSwap = (direction: LayoutDirection) => {
    endBoardPlacement();
    void controller.commitSwap(paneId, direction);
  };

  let note = "";
  if (kind === "split") {
    note = !sides.right && !sides.down ? t("boardCanvas.placeTooSmall")
      : !sides.right ? t("boardCanvas.placeNarrow") : !sides.down ? t("boardCanvas.placeShort") : "";
  } else if (!neighbours.size) {
    note = t("boardCanvas.placeNoNeighbor");
  }

  const ghost = (direction: SplitDirection, area: typeof rect, label: string): ReactNode =>
    <button type="button" key={direction} data-board-overlay="" className="board-place-ghost" style={px(area)}
      aria-label={label} onClick={(event) => { event.stopPropagation(); pickSplit(direction); }}>
      <span><Plus size={18} aria-hidden="true" />{label}</span>
    </button>;

  const viewport = viewportRef.current;
  const banner = <div className="board-place-banner" data-board-overlay="" role="status">
    <span>{t(kind === "split" ? "boardCanvas.placeSplit" : "boardCanvas.placeSwap")}{note ? ` · ${note}` : ""}</span>
    <button type="button" onClick={() => endBoardPlacement()}>{t("boardCanvas.placeCancel")}</button>
  </div>;

  return <>
    {others.filter((pane) => !neighbours.has(pane.paneId)).map((pane) =>
      <div key={pane.paneId} className="board-place-dim" aria-hidden="true" style={px(box(layout, pane.rect))} />)}
    {kind === "split" ? <>
      {sides.right ? ghost("right", { ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 }, t("boardCanvas.placeRight")) : null}
      {sides.down ? ghost("down", { ...rect, top: rect.top + rect.height / 2, height: rect.height / 2,
        width: sides.right ? rect.width / 2 : rect.width }, t("boardCanvas.placeDown")) : null}
    </> : [...neighbours].map(([id, direction]) => {
      const pane = others.find((item) => item.paneId === id)!;
      return <button type="button" key={id} data-board-overlay="" className="board-place-target" style={px(box(layout, pane.rect))}
        aria-label={t(LIFT_LABELS[direction])} onClick={(event) => { event.stopPropagation(); pickSwap(direction); }}>
        <span>{t(LIFT_LABELS[direction])}</span>
      </button>;
    })}
    <div className="board-place-self" aria-hidden="true" style={px(rect)} />
    {viewport ? createPortal(banner, viewport) : null}
  </>;
}
