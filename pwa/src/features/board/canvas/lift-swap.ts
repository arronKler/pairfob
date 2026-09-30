/**
 * Lift-to-swap on the board canvas.
 *
 * A long press lifts a tile: it follows the finger, the panes it touches become
 * drop targets labelled with the swap direction, every other pane dims. The
 * marks are data attributes and CSS variables on the rendered tiles, so the
 * React tree never re-renders at pointer speed; `finish` and `cancel` strip
 * every mark they set. Hit-testing uses tile rects, not `elementFromPoint`, so
 * the lifted tile under the finger never hides its target.
 */
import { t, type CopyKey } from "../../../lib/i18n";
import type { LayoutDirection } from "../../../lib/operations";

export type LiftResult = { target: string; direction: LayoutDirection | null; moved: boolean };
export type LiftSession = {
  move(point: { x: number; y: number }): void;
  finish(): LiftResult;
  cancel(): void;
};

const LABELS: Record<LayoutDirection, CopyKey> = {
  left: "boardCanvas.liftLeft",
  right: "boardCanvas.liftRight",
  up: "boardCanvas.liftUp",
  down: "boardCanvas.liftDown",
};

function contains(rect: DOMRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function startLift(
  root: HTMLElement,
  tile: HTMLElement,
  paneId: string,
  targets: ReadonlyMap<string, LayoutDirection>,
  origin: { x: number; y: number },
  slop: number,
): LiftSession {
  const tiles = [...root.querySelectorAll<HTMLElement>(".board-pane")];
  // The stage is scaled; a screen delta moves the tile by delta / scale stage px.
  const scale = tile.offsetWidth > 0 ? tile.getBoundingClientRect().width / tile.offsetWidth || 1 : 1;
  let moved = false;
  let over = "";
  tile.dataset.boardLift = "";
  for (const other of tiles) {
    const id = other.dataset.paneId || "";
    if (id === paneId) continue;
    const direction = targets.get(id);
    if (direction) {
      other.dataset.boardDrop = direction;
      other.dataset.boardDropLabel = t(LABELS[direction]);
    } else {
      other.dataset.boardDim = "";
    }
  }

  const clear = () => {
    delete tile.dataset.boardLift;
    tile.style.removeProperty("--board-lift-x");
    tile.style.removeProperty("--board-lift-y");
    for (const other of tiles) {
      delete other.dataset.boardDrop;
      delete other.dataset.boardDropLabel;
      delete other.dataset.boardDropOver;
      delete other.dataset.boardDim;
    }
  };

  return {
    move(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      if (!moved && Math.hypot(dx, dy) >= slop) moved = true;
      tile.style.setProperty("--board-lift-x", `${dx / scale}px`);
      tile.style.setProperty("--board-lift-y", `${dy / scale}px`);
      const hit = tiles.find((other) => other !== tile && targets.has(other.dataset.paneId || "")
        && contains(other.getBoundingClientRect(), point));
      const next = hit?.dataset.paneId || "";
      if (next === over) return;
      for (const other of tiles) {
        if ((other.dataset.paneId || "") === next) other.dataset.boardDropOver = "";
        else delete other.dataset.boardDropOver;
      }
      over = next;
    },
    finish() {
      clear();
      return { target: over, direction: over ? targets.get(over) ?? null : null, moved };
    },
    cancel: clear,
  };
}
