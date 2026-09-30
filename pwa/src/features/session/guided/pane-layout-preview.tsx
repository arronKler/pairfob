import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../../../lib/i18n";
import type { LayoutDirection, ResizePaneInput } from "../../../lib/operations";
import type { TabLayout, TabLayoutView } from "../../../lib/layout";
import { herdrNeighbor } from "../../board/model/pane-menu";
import {
  dividerAt,
  dividerMoveRequest,
  HERDR_RATIO_MAX,
  HERDR_RATIO_MIN,
  HERDR_RESIZE_STEP,
  layoutDividers,
  snapDividerRatio,
  type Divider,
} from "../../board/model/divider";
import { dragReadout } from "../../board/model/divider-drag";
import { layoutWithSplitRatio } from "../../board/model/layout-draft";

const LONG_PRESS_MS = 450;
const SLOP_PX = 8;

/** A pane's cell in percent of the tab area. */
export type CellBox = { paneId: string; x: number; y: number; width: number; height: number };

/** The tab as the desk draws it, in percent; a zoomed tab shows only the filled pane. */
export function layoutBoxes(layout: TabLayoutView, paneId: string): CellBox[] {
  const { area } = layout;
  // herdr reports every pane of a zoomed tab and zooms its focused pane; an older
  // daemon may list only the zoomed one. Either way the focused pane fills the tab.
  if (layout.zoomed) {
    const shown = layout.panes.find(pane => pane.paneId === layout.focusedPaneId)
      ?? layout.panes.find(pane => pane.focused) ?? layout.panes.find(pane => pane.paneId === paneId);
    return shown ? [{ paneId: shown.paneId, x: 0, y: 0, width: 100, height: 100 }] : [];
  }
  return layout.panes.map(pane => ({
    paneId: pane.paneId,
    x: ((pane.rect.x - area.x) / area.width) * 100, y: ((pane.rect.y - area.y) / area.height) * 100,
    width: (pane.rect.width / area.width) * 100, height: (pane.rect.height / area.height) * 100,
  }));
}

/** Terminal cells are about twice as tall as wide; the preview keeps the desk's proportions. */
export function layoutRatio(layout: TabLayoutView | null): number {
  if (!layout) return 1.6;
  return Math.min(2.4, Math.max(0.8, (layout.area.width / Math.max(1, layout.area.height)) / 2));
}

export function cellStyle(box: Pick<CellBox, "x" | "y" | "width" | "height">) {
  return { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` };
}

/** What a cell's title strip says about its pane: the agent state, or none for a plain terminal. */
export type CellStatus = "blocked" | "working" | "done" | "idle" | "";

type Drag = { divider: Divider; pointerId: number; start: number; ratio: number; grab: number };
type Draft = { splitId: string; ratio: number; pending: boolean };
type Bubble = { text: string; x: number; y: number };

function readout(divider: Divider, ratio: number): string {
  const { first, second, share, rows } = dragReadout(divider, ratio);
  return t(rows ? "boardCanvas.dragRows" : "boardCanvas.dragCols", { first: String(first), second: String(second), share: String(share) });
}

/**
 * The tab as herdr draws it, and the control: every herdr divider is a
 * handle (drag previews on whole cells with herdr's grab offset, release sends
 * one resize through `board/model/divider.ts`), long-press this cell and drop
 * it on a neighbour to swap, tap another cell to open it. The draft lives only
 * while a finger is down or a request is in flight; the snapshot decides.
 */
export function LayoutPreview({ layout, paneId, title, status, disabled, canResize, canSwap, onResize, onSwap, onOpen }: {
  layout: TabLayoutView; paneId: string;
  title: (paneId: string) => string;
  status: (paneId: string) => CellStatus;
  disabled: boolean; canResize: boolean; canSwap: boolean;
  /** False when nothing was sent (disabled, target gone): the preview drops its draft. */
  onResize: (request: ResizePaneInput) => boolean;
  onSwap: (direction: LayoutDirection | null) => void;
  onOpen: (paneId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [lift, setLift] = useState<{ dx: number; dy: number; target: string } | null>(null);
  const press = useRef<{ x: number; y: number; timer: number; lifted: boolean } | null>(null);
  const signature = JSON.stringify([layout.panes, layout.splits ?? [], layout.zoomed]);
  const wasDisabled = useRef(disabled);

  // A refreshed snapshot, or the end of the request the draft was waiting on, retires the draft.
  useEffect(() => { drag.current = null; setBubble(null); setDraft(null); }, [signature]);
  // A sheet closed mid-press must not fire the lift later on a detached cell.
  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer); }, []);
  useEffect(() => {
    if (wasDisabled.current && !disabled) setDraft(current => current?.pending ? null : current);
    wasDisabled.current = disabled;
  }, [disabled]);

  const shown = draft ? layoutWithSplitRatio(layout as TabLayout, draft.splitId, draft.ratio) : layout;
  const boxes = layoutBoxes(shown, paneId);
  const dividers = canResize ? layoutDividers(layout) : [];
  const focusedPane = layout.focusedPaneId || layout.panes.find(pane => pane.focused)?.paneId || "";

  const percent = (event: { clientX: number; clientY: number }) => {
    const rect = root.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100, y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100 };
  };
  /** The (fractional) terminal cell under a client point, along the divider's axis. */
  const cellUnder = (divider: Divider, event: { clientX: number; clientY: number }) => {
    const at = percent(event);
    return divider.direction === "right"
      ? layout.area.x + (at.x / 100) * layout.area.width
      : layout.area.y + (at.y / 100) * layout.area.height;
  };
  const cellAt = (x: number, y: number) => boxes.find(box => box.paneId !== paneId
    && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)?.paneId ?? "";

  const commit = (divider: Divider, ratio: number) => {
    const request = dividerMoveRequest(layout, divider, ratio);
    if (!request) { setDraft(null); return; }
    setDraft({ splitId: divider.id, ratio, pending: true });
    // Never leave a pending picture of a resize that did not go out.
    if (!onResize(request)) setDraft(null);
  };
  const cancelDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setBubble(null);
    setDraft(null);
  };
  const startDrag = (event: ReactPointerEvent, divider: Divider) => {
    if (event.button !== 0 || disabled || drag.current || draft?.pending) return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not every DOM implements capture */ }
    drag.current = { divider, pointerId: event.pointerId, start: divider.ratio, ratio: divider.ratio, grab: divider.at - cellUnder(divider, event) };
    const at = percent(event);
    setBubble({ text: readout(divider, divider.ratio), x: at.x, y: at.y });
  };
  const moveDrag = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    const ratio = snapDividerRatio(current.divider, cellUnder(current.divider, event) + current.grab, current.start);
    if (ratio !== current.ratio) {
      current.ratio = ratio;
      setDraft({ splitId: current.divider.id, ratio, pending: false });
    }
    const at = percent(event);
    setBubble({ text: readout(current.divider, ratio), x: at.x, y: at.y });
  };
  const endDrag = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    setBubble(null);
    // Released on the cell it started from: nothing moved on the computer.
    if (dividerAt(current.divider, current.ratio) === current.divider.at) { setDraft(null); return; }
    commit(current.divider, current.ratio);
  };
  const dividerKey = (event: KeyboardEvent, divider: Divider) => {
    const across = divider.direction === "right";
    const sign = event.key === (across ? "ArrowRight" : "ArrowDown") ? 1 : event.key === (across ? "ArrowLeft" : "ArrowUp") ? -1 : 0;
    if (!sign || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (disabled || draft?.pending) return;
    const ratio = Math.min(HERDR_RATIO_MAX, Math.max(HERDR_RATIO_MIN, divider.ratio + sign * HERDR_RESIZE_STEP));
    if (Math.abs(ratio - divider.ratio) > 1e-6) commit(divider, ratio);
  };

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setLift(null);
  };
  const pressDown = (event: ReactPointerEvent) => {
    if (disabled || !canSwap || !event.isPrimary || event.button !== 0) return;
    if (press.current) window.clearTimeout(press.current.timer);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    press.current = { ...start, lifted: false, timer: window.setTimeout(() => {
      if (!press.current || !target.isConnected) return;
      press.current.lifted = true;
      target.setPointerCapture?.(pointerId);
      setLift({ dx: 0, dy: 0, target: "" });
    }, LONG_PRESS_MS) };
  };
  const pressMove = (event: ReactPointerEvent) => {
    const state = press.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.lifted) { if (Math.hypot(dx, dy) > SLOP_PX) cancelPress(); return; }
    const at = percent(event);
    setLift({ dx, dy, target: cellAt(at.x, at.y) });
  };
  const pressUp = () => {
    const target = lift?.target;
    const lifted = press.current?.lifted;
    cancelPress();
    if (!lifted || !target) return;
    const direction = (["left", "right", "up", "down"] as const)
      .find(item => herdrNeighbor(layout, paneId, item) === target) ?? null;
    onSwap(direction);
  };

  const face = (id: string, label: string) => {
    const state = status(id);
    return <span>
      <b>{state ? <i className={`pane-layout-dot is-${state}`} aria-hidden="true" /> : null}{label}</b>
    </span>;
  };
  const cues = (id: string) => [status(id) === "blocked" ? " is-blocked" : "", id === focusedPane && id !== paneId ? " is-focused" : ""].join("");

  return <div ref={root} className={`pane-layout-preview${draft || lift ? " is-dragging" : ""}`} data-sheet-gesture="" role="group" aria-label={t("layout.previewAria")}
    style={{ aspectRatio: String(layoutRatio(layout)) }}>
    {boxes.map(box => {
      if (box.paneId === paneId) {
        return <span key={box.paneId} className={`pane-layout-cell is-current${cues(box.paneId)}${lift ? " is-lifted" : ""}`}
          style={{ ...cellStyle(box), ...(lift ? { transform: `translate(${lift.dx}px, ${lift.dy}px)` } : {}) }}
          onPointerDown={pressDown} onPointerMove={pressMove} onPointerUp={pressUp} onPointerCancel={cancelPress}
          onContextMenu={event => event.preventDefault()}>
          {face(box.paneId, t("pane.thisCell"))}
        </span>;
      }
      return <button key={box.paneId} type="button" className={`pane-layout-cell is-other${cues(box.paneId)}${lift?.target === box.paneId ? " is-target" : ""}`}
        style={cellStyle(box)} aria-label={t("board.paneAria", { title: title(box.paneId) })} onClick={() => onOpen(box.paneId)}>
        {face(box.paneId, title(box.paneId))}
      </button>;
    })}
    {dividers.map(divider => {
      const across = divider.direction === "right";
      const mine = draft?.splitId === divider.id ? draft : null;
      const ratio = mine ? mine.ratio : divider.ratio;
      const line = dividerAt(divider, ratio);
      const { area } = layout;
      // While one divider moves, the others would lag behind the live re-layout.
      const hidden = !!draft && !mine;
      const style = across
        ? { left: `${((line - area.x) / area.width) * 100}%`, top: `${((divider.rect.y - area.y) / area.height) * 100}%`, height: `${(divider.rect.height / area.height) * 100}%` }
        : { top: `${((line - area.y) / area.height) * 100}%`, left: `${((divider.rect.x - area.x) / area.width) * 100}%`, width: `${(divider.rect.width / area.width) * 100}%` };
      const className = ["pane-divider", across ? "is-v" : "is-h", mine && !mine.pending ? "is-active" : "", mine?.pending ? "is-pending" : "",
        hidden ? "is-hidden" : ""].filter(Boolean).join(" ");
      return <span key={divider.id} className={className} style={style} data-split-id={divider.id}
        role="slider" tabIndex={disabled || hidden ? -1 : 0} aria-label={t(across ? "boardCanvas.dividerWidth" : "boardCanvas.dividerHeight")}
        aria-orientation={across ? "horizontal" : "vertical"} aria-valuemin={10} aria-valuemax={90}
        aria-valuenow={Math.round(ratio * 100)} aria-valuetext={readout(divider, ratio)} aria-disabled={disabled || undefined}
        onPointerDown={event => startDrag(event, divider)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}
        onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
        onKeyDown={event => dividerKey(event, divider)} onContextMenu={event => event.preventDefault()}>
        <i className="pane-divider-knob" aria-hidden="true" />
      </span>;
    })}
    {bubble ? <span className="pane-layout-bubble" role="status" style={{ left: `${bubble.x}%`, top: `${bubble.y}%` }}>{bubble.text}</span> : null}
  </div>;
}
