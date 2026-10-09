import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Columns2, Plus } from "lucide-react";
import { BOARD_CELL_H, BOARD_CELL_W, type LayoutRect, type TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection, SplitDirection } from "../../../lib/operations";
import { t, type CopyKey } from "../../../lib/i18n";
import { handFocusOn, paneOpenButton } from "../canvas/pane-focus";
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
 * Where a canvas mode says what it is: the tab row of the board this canvas
 * belongs to (`.board-mode`), which the mode takes over while it lasts. Drawn
 * on the canvas, a hint lands on a pane head or a target as soon as the stage
 * fills its window, which it does on a phone on its side and beside the list.
 * A canvas shown without that row keeps the hint on itself.
 */
function modeSlot(viewport: HTMLElement | null): HTMLElement | null {
  return viewport?.closest(".board-shell")?.querySelector<HTMLElement>(".board-mode") ?? viewport;
}

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
  // What held focus when the mode began: the pane control its menu gave focus back to.
  const cameFrom = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!valid) return;
    const active = document.activeElement;
    cameFrom.current = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => { cameFrom.current = null; };
  }, [valid]);
  /**
   * The mode's own controls (a ghost, a target, Cancel) leave with it, and the
   * focus a click or Tab gave one of them would be dropped. Before the mode
   * ends it goes back to where it came from, so what opens next (the split
   * sheet) returns there too, and Escape leaves the reader on the pane.
   */
  const leave = useRef(() => {});
  leave.current = () => {
    const held = document.activeElement?.closest(".board-place-ghost, .board-place-target, .board-place-banner");
    handFocusOn(held, cameFrom.current?.isConnected ? cameFrom.current : paneOpenButton(viewportRef.current, paneId));
    endBoardPlacement();
  };
  useEffect(() => {
    if (!valid) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      leave.current();
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
    leave.current();
    controller.pickSplit(paneId, direction);
  };
  const pickSwap = (direction: LayoutDirection) => {
    leave.current();
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

  const slot = modeSlot(viewportRef.current);
  const banner = <div className="board-mode-bar board-place-banner" data-board-overlay="" role="status">
    {kind === "split" ? <Columns2 size={18} aria-hidden="true" /> : <ArrowLeftRight size={18} aria-hidden="true" />}
    <p className="board-mode-text">
      <span>{t(kind === "split" ? "boardCanvas.placeSplit" : "boardCanvas.placeSwap")}</span>
      {note ? <small>{note}</small> : null}
    </p>
    <button type="button" className="board-mode-cancel" onClick={() => leave.current()}>{t("boardCanvas.placeCancel")}</button>
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
    {slot ? createPortal(banner, slot) : null}
  </>;
}
