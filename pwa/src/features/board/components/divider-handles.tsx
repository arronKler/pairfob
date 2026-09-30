import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BOARD_CELL_H, BOARD_CELL_W, type TabLayoutView } from "../../../lib/layout";
import { t } from "../../../lib/i18n";
import { dividerAt, dividerMoveRequest, HERDR_RATIO_MAX, HERDR_RATIO_MIN, HERDR_RESIZE_STEP, layoutDividers, snapDividerRatio, type Divider } from "../model/divider";
import { cellAt, dragReadout, firstSidePane, stageBox, type StageBox } from "../model/divider-drag";
import { clearLayoutDraft, layoutDraft, setLayoutDraft, subscribeLayoutDraft } from "../model/draft-store";
import { BOARD_GESTURE_SLOP_PX } from "../model/gesture";
import type { BoardCanvasController } from "./canvas-controller";

type Drag = {
  divider: Divider;
  pointerId: number;
  start: number;
  ratio: number;
  /** Line minus press cell, so pressing never makes the divider jump (herdr's grab offset). */
  grab: number;
  box: StageBox;
  signature: string;
  /** Where the finger went down: a release within the slop is a tap, not a drag. */
  x: number;
  y: number;
  travelled: boolean;
};

/** A point inside the canvas viewport, for the bubble drawn over everything. */
export type ViewportPoint = { x: number; y: number };

function readout(divider: Divider, ratio: number): string {
  const { first, second, share, rows } = dragReadout(divider, ratio);
  return t(rows ? "boardCanvas.dragRows" : "boardCanvas.dragCols", { first: String(first), second: String(second), share: String(share) });
}

/**
 * Divider handles: one per herdr split, in stage coordinates and counter-scaled
 * so the knob and hit area keep their screen size at any zoom.
 *
 * A drag previews on the phone only (the layout draft) and commits once on
 * release through `dividerMoveRequest`; a release on the same cell is a tap and
 * opens the stepper for the pane on the first side. While a request is in
 * flight the draft stays pending, then clears so the snapshot redraw decides.
 */
export function DividerHandles({ layout, signature, enabled, controller, viewportRef, stageRef, onHint }: {
  layout: TabLayoutView;
  /** False when the computer cannot resize (no resize_pane) or the layout is only a stand-in: no handles at all. */
  enabled: boolean;
  signature: string;
  controller: BoardCanvasController;
  viewportRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  onHint(text: string, point: ViewportPoint): void;
}) {
  const draft = useSyncExternalStore(subscribeLayoutDraft, layoutDraft);
  const drag = useRef<Drag | null>(null);
  /** Pointers down on the canvas right now, so a finger that joins a pinch never starts a drag. */
  const active = useRef(new Set<number>());
  const [bubble, setBubble] = useState<{ text: string; point: ViewportPoint } | null>(null);
  const dividers = layoutDividers(layout);
  const locked = controller.layoutReason("resize");
  const tabDraft = draft && draft.tabId === layout.tabId ? draft : null;

  const toViewport = (clientX: number, clientY: number): ViewportPoint => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const cancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setBubble(null);
    setLayoutDraft(null);
  };
  const commit = (divider: Divider, ratio: number) => {
    const request = dividerMoveRequest(layout, divider, ratio);
    if (!request) { setLayoutDraft(null); return; }
    const pending = { tabId: layout.tabId, splitId: divider.id, ratio, pending: true };
    setLayoutDraft(pending);
    void Promise.resolve(controller.commitResize(request)).finally(() => clearLayoutDraft(pending));
  };

  // A layout that changed under the finger (another client, a refresh) ends the drag.
  useEffect(() => {
    if (drag.current && drag.current.signature !== signature) cancel();
  }, [signature]);
  // A second finger belongs to the canvas (pinch): the drag gives way.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const down = (event: PointerEvent) => {
      active.current.add(event.pointerId);
      if (drag.current && event.pointerId !== drag.current.pointerId) cancel();
    };
    const up = (event: PointerEvent) => { active.current.delete(event.pointerId); };
    viewport.addEventListener("pointerdown", down, true);
    viewport.addEventListener("pointerup", up, true);
    viewport.addEventListener("pointercancel", up, true);
    return () => {
      viewport.removeEventListener("pointerdown", down, true);
      viewport.removeEventListener("pointerup", up, true);
      viewport.removeEventListener("pointercancel", up, true);
      cancel();
    };
  }, [viewportRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, divider: Divider) => {
    // Another finger is already down: this one is part of a pinch, which the canvas owns.
    if (event.button !== 0 || drag.current || active.current.size > 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked) { onHint(locked, toViewport(event.clientX, event.clientY)); return; }
    if (tabDraft?.pending) return;
    const stage = stageRef.current;
    if (!stage) return;
    const box = stageBox(stage);
    const press = cellAt(divider, layout.area, box, event.clientX, event.clientY);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not every DOM implements capture */ }
    drag.current = { divider, pointerId: event.pointerId, start: divider.ratio, ratio: divider.ratio, grab: divider.at - press, box, signature,
      x: event.clientX, y: event.clientY, travelled: false };
    setBubble({ text: readout(divider, divider.ratio), point: toViewport(event.clientX, event.clientY) });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= BOARD_GESTURE_SLOP_PX) current.travelled = true;
    const cell = cellAt(current.divider, layout.area, current.box, event.clientX, event.clientY) + current.grab;
    const ratio = snapDividerRatio(current.divider, cell, current.start);
    if (ratio !== current.ratio) {
      current.ratio = ratio;
      setLayoutDraft({ tabId: layout.tabId, splitId: current.divider.id, ratio, pending: false });
    }
    setBubble({ text: readout(current.divider, ratio), point: toViewport(event.clientX, event.clientY) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    setBubble(null);
    if (dividerAt(current.divider, current.ratio) === current.divider.at) {
      setLayoutDraft(null);
      // Only a press that stayed put is a tap; a swipe that came back to the same cell does nothing.
      const pane = current.travelled ? "" : firstSidePane(layout, current.divider);
      if (pane) controller.openResizeSheet(pane);
      return;
    }
    commit(current.divider, current.ratio);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, divider: Divider) => {
    const across = divider.direction === "right";
    const sign = event.key === (across ? "ArrowRight" : "ArrowDown") ? 1 : event.key === (across ? "ArrowLeft" : "ArrowUp") ? -1 : 0;
    if (!sign || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.getBoundingClientRect();
    if (locked) { onHint(locked, toViewport(target.left + target.width / 2, target.top)); return; }
    if (tabDraft?.pending) return;
    const ratio = Math.min(HERDR_RATIO_MAX, Math.max(HERDR_RATIO_MIN, divider.ratio + sign * HERDR_RESIZE_STEP));
    if (Math.abs(ratio - divider.ratio) < 1e-6) { onHint(t("boardCanvas.keyLimit"), toViewport(target.left + target.width / 2, target.top)); return; }
    commit(divider, ratio);
  };

  const viewport = viewportRef.current;
  if (!enabled) return null;
  return <>
    {dividers.map((divider) => {
      const across = divider.direction === "right";
      const mine = tabDraft?.splitId === divider.id ? tabDraft : null;
      const ratio = mine ? mine.ratio : divider.ratio;
      const line = dividerAt(divider, ratio);
      // While one divider moves the others would lag behind the live re-layout; hide them.
      const hidden = !!tabDraft && !mine;
      const style = across
        ? { left: `${(line - layout.area.x) * BOARD_CELL_W}px`, top: `${(divider.rect.y - layout.area.y) * BOARD_CELL_H}px`, height: `${divider.rect.height * BOARD_CELL_H}px` }
        : { top: `${(line - layout.area.y) * BOARD_CELL_H}px`, left: `${(divider.rect.x - layout.area.x) * BOARD_CELL_W}px`, width: `${divider.rect.width * BOARD_CELL_W}px` };
      const { first, second } = dragReadout(divider, ratio);
      const className = ["board-divider", across ? "is-v" : "is-h", locked ? "is-locked" : "", mine && !mine.pending ? "is-active" : "",
        mine?.pending ? "is-pending" : "", hidden ? "is-hidden" : ""].filter(Boolean).join(" ");
      return <div key={divider.id} data-board-overlay="" data-split-id={divider.id} className={className} style={style}
        role="slider" tabIndex={hidden ? -1 : 0} aria-label={t(across ? "boardCanvas.dividerWidth" : "boardCanvas.dividerHeight")}
        aria-orientation={across ? "horizontal" : "vertical"} aria-valuemin={10} aria-valuemax={90}
        aria-valuenow={Math.round(ratio * 100)} aria-valuetext={t(across ? "boardCanvas.dragCols" : "boardCanvas.dragRows",
          { first: String(first), second: String(second), share: String(Math.round(ratio * 100)) })}
        aria-disabled={locked ? true : undefined}
        onPointerDown={(event) => onPointerDown(event, divider)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={cancel} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
        onKeyDown={(event) => onKeyDown(event, divider)} onContextMenu={(event) => event.preventDefault()}>
        <span className="board-divider-knob" aria-hidden="true" />
      </div>;
    })}
    {bubble && viewport ? createPortal(<div className="board-drag-bubble" role="status"
      style={{ left: `${bubble.point.x}px`, top: `${bubble.point.y}px` }}>{bubble.text}</div>, viewport) : null}
  </>;
}
