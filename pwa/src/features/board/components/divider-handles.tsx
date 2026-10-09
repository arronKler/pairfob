import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BOARD_CELL_H, BOARD_CELL_W, type TabLayoutView } from "../../../lib/layout";
import { t } from "../../../lib/i18n";
import { dividerAt, dividerMoveRequest, HERDR_RATIO_MAX, HERDR_RATIO_MIN, HERDR_RESIZE_STEP, layoutDividers, snapDividerRatio, type Divider } from "../model/divider";
import { cellAt, dragReadout, firstSidePane, stageBox, type StageBox } from "../model/divider-drag";
import { clearLayoutDraft, layoutDraft, setLayoutDraft, subscribeLayoutDraft } from "../model/draft-store";
import { BOARD_GESTURE_SLOP_PX } from "../model/gesture";
import { swallowReleaseClick } from "../../../shared/ui/overlay/object-press";
import type { BoardCanvasController } from "./canvas-controller";

/** How long after a tap its own click can still arrive (a touch click trails the lift). */
const RELEASE_CLICK_MS = 700;

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
  /** The pane ⋯ whose target the press landed in: a tap there asks for that pane's menu. */
  more: HTMLElement | null;
  /** The divider cannot move now (locked, or a move still in flight): the press can only be that tap. */
  still: boolean;
};

/**
 * The pane ⋯ whose target holds this point, if any. The 28px band runs over the
 * corner where a ⋯ sits. The ⋯ is drawn above it, but a browser aims a finger
 * at whichever control its contact area favours, and beside the seam that is
 * the band: the press arrives here although the ⋯ is on top. Asking what is
 * drawn at the point counts the ⋯'s whole target, slop included.
 */
function paneMoreAt(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document.elementsFromPoint !== "function") return null;
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element instanceof HTMLElement && element.matches(".board-pane-more")) return element;
  }
  return null;
}

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
 * opens the stepper for the pane on the first side, or the pane menu when the
 * press landed in a pane's ⋯ target. While a request is in flight the draft
 * stays pending, then clears so the snapshot redraw decides.
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
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setBubble(null);
    // A press on a divider that could not move drew no draft; the one in flight is not its to drop.
    if (!current.still) setLayoutDraft(null);
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
    const more = paneMoreAt(event.clientX, event.clientY);
    // A divider that cannot move says why; inside a ⋯ target the press is for the menu, which needs no divider.
    const still = !!locked || !!tabDraft?.pending;
    if (still && !more) { if (locked) onHint(locked, toViewport(event.clientX, event.clientY)); return; }
    const stage = stageRef.current;
    if (!stage) return;
    const box = stageBox(stage);
    const press = cellAt(divider, layout.area, box, event.clientX, event.clientY);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not every DOM implements capture */ }
    drag.current = { divider, pointerId: event.pointerId, start: divider.ratio, ratio: divider.ratio, grab: divider.at - press, box, signature,
      x: event.clientX, y: event.clientY, travelled: false, more, still };
    if (!still) setBubble({ text: readout(divider, divider.ratio), point: toViewport(event.clientX, event.clientY) });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= BOARD_GESTURE_SLOP_PX) current.travelled = true;
    if (current.still) return;
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
      if (!current.still) setLayoutDraft(null);
      // Only a press that stayed put is a tap; a swipe that came back to the same cell does nothing.
      if (current.travelled) return;
      const tile = current.more?.closest<HTMLElement>(".board-pane");
      const pane = current.more ? "" : firstSidePane(layout, current.divider);
      if (tile?.dataset.paneId) controller.openMenu?.(tile.dataset.paneId, { x: event.clientX, y: event.clientY }, tile);
      else if (pane) controller.openResizeSheet(pane);
      else return;
      // The sheet is up before the browser sends this release's own click, which
      // would then press whatever the sheet shows at that spot.
      swallowReleaseClick(event.currentTarget.ownerDocument, event.pointerId, { withinMs: RELEASE_CLICK_MS });
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
