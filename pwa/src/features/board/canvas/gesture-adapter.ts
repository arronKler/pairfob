/**
 * Board canvas gesture adapter.
 *
 * Owns the whole pointer lifetime of the board canvas: capture, the slop that
 * separates a tap from a drag, pan vs pane-scroll vs two fingers (which move
 * and zoom the board, see `model/pinch.ts`), wheel zoom, pan and remote
 * scroll, the tap synthesis that a prevented gesture still owes the tile or
 * its ⋯, the click suppression that keeps a finished drag from reopening a
 * pane, and the cancelled touch end that keeps a held press from tapping the
 * menu it opened. Everything stateful lives in
 * `BoardCanvasPorts`, so this module is independent of the application store
 * implementation, and disposing it retires every listener, frame and
 * in-flight gesture.
 *
 * A long press lifts the tile when the ports can swap (see `lift-swap.ts`):
 * releasing in place still opens the menu, dropping on a neighbour swaps.
 * Presses on overlay controls (`[data-board-overlay]`: divider handles,
 * placement ghosts) are theirs alone, so a divider drag never pans. The
 * camera keys (0 fit, ⌘/Ctrl ± zoom) live here with the camera, and every
 * camera written here is bounded so the board cannot leave its viewport
 * (`settleCamera`); when the viewport's box changes the camera follows it.
 */
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection } from "../../../lib/operations";
import { boardDragMode, boardScrollLines, boardWheelPan, boardWheelTravel, BOARD_GESTURE_SLOP_PX } from "../model/gesture";
import { panCamera, type BoardCamera } from "../model/camera";
import { swapTargets } from "../model/lift";
import { startPinch, stepPinch, type Pinch } from "../model/pinch";
import { startLift, type LiftSession } from "./lift-swap";
import { haptic } from "../../../shared/ui/dom/feedback";
import { swallowReleaseClick } from "../../../shared/ui/overlay/object-press";
import {
  applyCameraTransform,
  boardTallerThanViewport,
  cameraWithinViewport,
  fitCameraToViewport,
  settleCamera,
  viewportCenter,
  wheelPanWithinViewport,
  zoomCameraAtPoint,
} from "./transform";

/** How long after a tap its own click can still arrive (a touch click trails the lift). */
const RELEASE_CLICK_MS = 700;
/**
 * A wheel that was moving the board keeps to the board until it has rested
 * this long, as nested scrolling does: the tail of the turn that brought the
 * board to its edge must not start scrolling a pane on the computer.
 */
const WHEEL_BOARD_LATCH_MS = 250;

export type BoardCanvasPorts = {
  readCamera(): BoardCamera;
  writeCamera(camera: BoardCamera): void;
  /**
   * The whole-tab fit the camera was last checked against. It outlives one
   * binding, so a board that was away while its box changed (the phone turned
   * with a session open over it) is still known to have been fitted.
   */
  readFit?(): BoardCamera | null;
  writeFit?(fit: BoardCamera): void;
  /**
   * Remote scroll of one pane in the bound layout. Resolves true when the
   * daemon applied it, which is what earns a fresh thumbnail.
   */
  scrollPane(
    layout: TabLayout,
    paneId: string,
    direction: "up" | "down",
    lines: number,
  ): Promise<boolean> | boolean;
  requestPanePreview(paneId: string): void;
  openPane(paneId: string, tile?: HTMLElement): void;
  openMenu?(paneId: string, point: { x: number; y: number }, tile: HTMLElement): void;
  /** Swap with a neighbour. Without it a long press opens the menu as before. */
  commitSwap?(paneId: string, direction: LayoutDirection): Promise<void> | void;
  /** Why a swap cannot run now; a non-empty reason also falls back to the menu. */
  swapReason?(): string;
  /**
   * Placement mode (pick where a split goes / whom to swap with). While it is
   * on, pan and pinch still work, but a tap anywhere but a ghost or target
   * leaves placement instead of opening a pane, and a long press does nothing.
   */
  placementActive?(): boolean;
  endPlacement?(): void;
};

export const BOARD_LONG_PRESS_MS = 500;

const WHEEL_ZOOM_FACTOR = 1.08;
const KEY_ZOOM_FACTOR = 1.2;

function onOverlay(event: Event): boolean {
  return event.target instanceof Element && !!event.target.closest("[data-board-overlay]");
}

function paneIdFromEvent(event: Event): string {
  const node = event.target instanceof Element ? event.target.closest(".board-pane") : null;
  return node instanceof HTMLElement ? node.dataset.paneId || "" : "";
}

export function bindBoardCanvasGestures(
  viewport: HTMLElement,
  stage: HTMLElement,
  layout: TabLayout,
  ports: BoardCanvasPorts,
): () => void {
  let retired = false;
  applyCameraTransform(stage, ports.readCamera());
  const frame = requestAnimationFrame(() => {
    if (retired || !viewport.isConnected) return;
    // First open fits the whole tab so every pane cell is on screen.
    if (ports.readCamera().fitted) return;
    writeCamera(fitCameraToViewport(viewport, layout));
  });

  const pointers = new Map<number, { x: number; y: number }>();
  /**
   * Fingers that went down on an overlay control (a divider handle) while no
   * canvas gesture ran. The control owns them alone; when a second finger lands
   * on the canvas they join it as a pinch (the handle gives its drag up).
   */
  const overlayPointers = new Map<number, { x: number; y: number }>();
  let origin = { x: 0, y: 0 };
  let hitPane = "";
  /** The pane's ⋯ the press began on: a drag from it is the pane's, a tap is its own. */
  let hitMore: HTMLElement | null = null;
  let mode: "undecided" | "pan" | "scroll" | "pinch" = "undecided";
  let moved = false;
  let pinch: Pinch | null = null;
  /**
   * Fingers that have moved since the last two-finger step. A browser reports
   * two fingers one after the other, and between the two reports their distance
   * is not the fingers' own, so a step waits until both have spoken, or until
   * one speaks twice while the other rests.
   */
  const pinchMoved = new Set<number>();
  let wheelOnBoardAt = Number.NEGATIVE_INFINITY;
  let scrollRemainder = 0;
  let held = false;
  let syntheticClick = false;
  let longPress: ReturnType<typeof setTimeout> | undefined;
  let lift: { session: LiftSession; paneId: string; tile: HTMLElement } | null = null;
  const cancelLongPress = () => { clearTimeout(longPress); longPress = undefined; };
  const dropLift = () => { lift?.session.cancel(); lift = null; };

  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });

  /** Every camera this adapter writes is bounded on the way (`settleCamera`). */
  function writeCamera(camera: BoardCamera): void {
    settleCamera(stage, camera, (next) => ports.writeCamera(next));
  }

  /**
   * The board follows its box (a rotation, a window resize, the list giving
   * way): otherwise the camera for the old box is left cut off or adrift in the
   * new one. What the reader did to it decides how. At the old fit's scale they
   * have not zoomed, wherever they slid the board, so it is fitted again; at a
   * scale of their own the camera is theirs and is only brought back into view.
   */
  let fitSeen: BoardCamera | null = ports.readFit?.() ?? null;
  const sameScale = (a: BoardCamera, b: BoardCamera) => Math.abs(a.scale - b.scale) < 0.002;
  const sameView = (a: BoardCamera, b: BoardCamera) =>
    sameScale(a, b) && Math.abs(a.panX - b.panX) < 1.5 && Math.abs(a.panY - b.panY) < 1.5;
  const boxWatch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (retired || !viewport.isConnected || !viewport.clientWidth || pointers.size) return;
    const fit = fitCameraToViewport(viewport, layout);
    const seen = fitSeen;
    fitSeen = fit;
    ports.writeFit?.(fit);
    const camera = ports.readCamera();
    // A camera that was never fitted is the first frame's to place.
    if (!camera.fitted) return;
    const unzoomed = !!seen && !sameView(fit, seen) && sameScale(camera, seen);
    const next = unzoomed ? fit : cameraWithinViewport(stage, camera);
    if (next !== camera) writeCamera(next);
  });
  boxWatch?.observe(viewport);

  function zoomAt(clientX: number, clientY: number, nextScale: number): void {
    const next = zoomCameraAtPoint(ports.readCamera(), viewport, clientX, clientY, nextScale);
    if (next) writeCamera(next);
  }

  /** Move and zoom the board with the two fingers as they are now. */
  function pinchStep(): void {
    pinchMoved.clear();
    if (!pinch || pointers.size !== 2) return;
    const [a, b] = [...pointers.values()];
    const frame = viewport.getBoundingClientRect();
    const camera = ports.readCamera();
    const step = stepPinch(pinch, camera, { left: frame.left, top: frame.top }, a, b);
    pinch = step.pinch;
    if (step.camera !== camera) writeCamera(step.camera);
  }

  function scrollPane(paneId: string, direction: "up" | "down", lines: number): void {
    if (!paneId || lines < 1) return;
    void Promise.resolve(ports.scrollPane(layout, paneId, direction, lines)).then(
      (applied) => {
        if (applied && !retired) ports.requestPanePreview(paneId);
      },
      () => undefined,
    );
  }

  const onDown = (event: PointerEvent) => {
    if (retired) return;
    if (!pointers.size && onOverlay(event)) {
      // This control owns a fresh press, not the trailing click of the last
      // canvas drag or long press. Let its native click reach the placement UI.
      if (!overlayPointers.size) { held = false; moved = false; }
      overlayPointers.set(event.pointerId, point(event));
      return;
    }
    if (lift) { dropLift(); held = true; }
    if (event.button === 2) { held = false; moved = false; cancelLongPress(); return; }
    if (event.button !== 0) return;
    cancelLongPress();
    if (held && pointers.size) return;
    held = false;
    const next = point(event);
    for (const [id, at] of overlayPointers) pointers.set(id, at);
    overlayPointers.clear();
    pointers.set(event.pointerId, next);
    origin = next;
    hitPane = paneIdFromEvent(event);
    hitMore = event.target instanceof Element ? event.target.closest<HTMLElement>(".board-pane-more") : null;
    moved = false;
    mode = "undecided";
    scrollRemainder = 0;
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom/happy-dom may not implement capture */
    }
    if (pointers.size >= 2) {
      moved = true;
      const [a, b] = [...pointers.values()];
      pinch = pointers.size === 2 ? startPinch(a, b, ports.readCamera().scale) : null;
      pinchMoved.clear();
      mode = "pinch";
      hitPane = "";
      hitMore = null;
    }
    if (pointers.size === 1 && hitPane && ports.openMenu && event.pointerType !== "mouse" && !ports.placementActive?.()) {
      const tile = (event.target as Element).closest<HTMLElement>(".board-pane");
      if (tile) longPress = setTimeout(() => {
        if (retired || moved || pointers.size !== 1 || !tile.isConnected) return;
        held = true;
        moved = true;
        // The hold has armed: say so before anything is drawn.
        haptic(8);
        const targets = ports.commitSwap && !ports.swapReason?.() ? swapTargets(layout, hitPane) : new Map();
        if (!targets.size) { ports.openMenu!(hitPane, origin, tile); return; }
        lift = { session: startLift(viewport, tile, hitPane, targets, origin, BOARD_GESTURE_SLOP_PX), paneId: hitPane, tile };
      }, BOARD_LONG_PRESS_MS);
    }
    if (event.pointerType === "touch" || event.pointerType === "pen") event.preventDefault();
  };

  const onMove = (event: PointerEvent) => {
    if (overlayPointers.has(event.pointerId)) { overlayPointers.set(event.pointerId, point(event)); return; }
    if (lift && pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, point(event));
      lift.session.move(point(event));
      event.preventDefault();
      return;
    }
    if (retired || held || !pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId)!;
    const next = point(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 2) {
      mode = "pinch";
      moved = true;
      event.preventDefault();
      const again = pinchMoved.has(event.pointerId);
      pinchMoved.add(event.pointerId);
      if (pinchMoved.size < 2 && !again) return;
      pinchStep();
      // The other finger rests: this one's next report needs no partner.
      if (again) pinchMoved.add(event.pointerId);
      return;
    }
    const fromOriginX = next.x - origin.x;
    const fromOriginY = next.y - origin.y;
    if (mode === "undecided") {
      if (Math.hypot(fromOriginX, fromOriginY) < BOARD_GESTURE_SLOP_PX) return;
      cancelLongPress();
      // A mouse moves a board it can only see part of; a finger has two for that.
      const boardFirst = event.pointerType === "mouse" && boardTallerThanViewport(stage, ports.readCamera());
      mode = boardDragMode(fromOriginX, fromOriginY, hitPane, boardFirst);
      moved = true;
      event.preventDefault();
      if (mode === "pan") {
        writeCamera(panCamera(ports.readCamera(), fromOriginX, fromOriginY));
      } else {
        const stepped = boardScrollLines(0, fromOriginY);
        scrollRemainder = stepped.remainder;
        if (stepped.lines) scrollPane(hitPane, stepped.direction, stepped.lines);
      }
      return;
    }
    if (mode === "pan") {
      moved = true;
      event.preventDefault();
      writeCamera(panCamera(ports.readCamera(), next.x - prev.x, next.y - prev.y));
      return;
    }
    if (mode !== "scroll") return;
    moved = true;
    event.preventDefault();
    const stepped = boardScrollLines(scrollRemainder, next.y - prev.y);
    scrollRemainder = stepped.remainder;
    if (stepped.lines) scrollPane(hitPane, stepped.direction, stepped.lines);
  };

  const end = (event: PointerEvent) => {
    overlayPointers.delete(event.pointerId);
    if (retired || !pointers.has(event.pointerId)) return;
    cancelLongPress();
    // A report still waiting for its partner is the fingers' last word.
    if (pinchMoved.size) pinchStep();
    pointers.delete(event.pointerId);
    if (lift) {
      const { session, paneId, tile } = lift;
      lift = null;
      const result = session.finish();
      if (result.target && result.direction) void ports.commitSwap?.(paneId, result.direction);
      else if (!result.moved && tile.isConnected) ports.openMenu?.(paneId, origin, tile);
      event.preventDefault();
      return;
    }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      // In placement a tap only leaves placement; the ghosts and targets are overlays of their own.
      if (!moved && !held && ports.placementActive?.()) {
        ports.endPlacement?.();
        moved = true;
      }
      // A gesture that never moved is a tap: hand it to the tile it started on,
      // or to that tile's ⋯ when it started there.
      if (!moved && !held && hitPane) {
        for (const tile of viewport.querySelectorAll<HTMLButtonElement>(".board-pane")) {
          if (tile.dataset.paneId !== hitPane) continue;
          const more = hitMore && tile.contains(hitMore) ? hitMore : null;
          syntheticClick = true;
          (more ?? tile.querySelector<HTMLElement>(".board-pane-open") ?? tile).click();
          syntheticClick = false;
          // The tap opened the session (or the menu) and the board is gone or
          // covered before the browser sends this release's own click, which
          // would then press whatever shows at that spot (the compose field,
          // a key, a row).
          swallowReleaseClick(viewport.ownerDocument, event.pointerId, { withinMs: RELEASE_CLICK_MS });
          moved = true;
          break;
        }
      }
      if (mode === "scroll" && hitPane) ports.requestPanePreview(hitPane);
      mode = "undecided";
    }
    if (moved) event.preventDefault();
  };

  const cancel = (event: PointerEvent) => {
    overlayPointers.delete(event.pointerId);
    if (!pointers.has(event.pointerId)) return;
    cancelLongPress();
    dropLift();
    pointers.clear();
    pinchMoved.clear();
    hitPane = "";
    hitMore = null;
    moved = true;
    mode = "undecided";
    pinch = null;
  };

  const onWheel = (event: WheelEvent) => {
    if (retired) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, ports.readCamera().scale * wheelFactor(event.deltaY));
      return;
    }
    // Sideways pans the board wherever it lands. Vertical over a pane first
    // moves a board that reaches past its window (getting around it comes
    // before reading one pane of it), and scrolls that pane once the board's
    // edge is in view, which at the fit it always is.
    const sideways = boardWheelPan(event, viewport.clientWidth);
    if (sideways) {
      event.preventDefault();
      writeCamera(panCamera(ports.readCamera(), -sideways, 0));
      return;
    }
    const paneId = paneIdFromEvent(event);
    if (paneId) {
      event.preventDefault();
      const camera = ports.readCamera();
      const pan = wheelPanWithinViewport(stage, camera, boardWheelTravel(event, viewport.clientHeight));
      const latched = event.timeStamp - wheelOnBoardAt < WHEEL_BOARD_LATCH_MS;
      if (pan || latched) {
        wheelOnBoardAt = event.timeStamp;
        if (pan) writeCamera(panCamera(camera, 0, pan));
        return;
      }
      const stepped = boardScrollLines(scrollRemainder, -event.deltaY);
      scrollRemainder = stepped.remainder;
      if (stepped.lines) scrollPane(paneId, stepped.direction, stepped.lines);
      return;
    }
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, ports.readCamera().scale * wheelFactor(event.deltaY));
  };

  /** Camera keys; the pane keys (select, swap, resize…) are the overlay's. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (retired || event.defaultPrevented || event.altKey) return;
    const modified = event.metaKey || event.ctrlKey;
    if (!modified && !event.shiftKey && event.key === "0") {
      writeCamera(fitCameraToViewport(viewport, layout));
    } else if (modified && (event.key === "=" || event.key === "+")) {
      const center = viewportCenter(viewport);
      zoomAt(center.x, center.y, ports.readCamera().scale * KEY_ZOOM_FACTOR);
    } else if (modified && event.key === "-") {
      const center = viewportCenter(viewport);
      zoomAt(center.x, center.y, ports.readCamera().scale / KEY_ZOOM_FACTOR);
    } else {
      return;
    }
    event.preventDefault();
  };

  const onClick = (event: MouseEvent) => {
    if (retired || syntheticClick || !moved || event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * A held press has done its work by the time the finger leaves: the menu is
   * open, or the tile was lifted. Its release must not tap as well. The menu
   * is a dialog, so the tap's click would land on whichever row came up under
   * the finger, outside the canvas where `onClick` could stop it. Cancelling
   * the touch's end cancels the tap at its source, and nothing is left waiting
   * for a click that most phones never send after a hold.
   */
  const onTouchEnd = (event: TouchEvent) => {
    if (!retired && held && event.cancelable) event.preventDefault();
  };

  const onContextMenu = (event: MouseEvent) => {
    const paneId = paneIdFromEvent(event);
    const tile = event.target instanceof Element ? event.target.closest<HTMLElement>(".board-pane") : null;
    if (!paneId || !tile || !ports.openMenu) return;
    event.preventDefault();
    event.stopPropagation();
    cancelLongPress();
    if (held || (pointers.size && moved)) return;
    held = true;
    moved = true;
    const rect = tile.getBoundingClientRect();
    ports.openMenu(paneId, event.clientX || event.clientY ? point(event as PointerEvent)
      : { x: rect.right - 12, y: rect.top + 32 }, tile);
  };

  viewport.addEventListener("pointerdown", onDown, { capture: true, passive: false });
  viewport.addEventListener("pointermove", onMove, { capture: true, passive: false });
  viewport.addEventListener("pointerup", end, true);
  viewport.addEventListener("pointercancel", cancel, true);
  viewport.addEventListener("lostpointercapture", cancel, true);
  viewport.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("contextmenu", onContextMenu, true);
  viewport.addEventListener("keydown", onKeyDown);

  return () => {
    retired = true;
    cancelLongPress();
    dropLift();
    pinchMoved.clear();
    for (const id of pointers.keys()) {
      if (viewport.hasPointerCapture?.(id)) viewport.releasePointerCapture(id);
    }
    pointers.clear();
    cancelAnimationFrame(frame);
    boxWatch?.disconnect();
    viewport.removeEventListener("pointerdown", onDown, true);
    viewport.removeEventListener("pointermove", onMove, true);
    viewport.removeEventListener("pointerup", end, true);
    viewport.removeEventListener("pointercancel", cancel, true);
    viewport.removeEventListener("lostpointercapture", cancel, true);
    viewport.removeEventListener("touchend", onTouchEnd, true);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("click", onClick, true);
    viewport.removeEventListener("contextmenu", onContextMenu, true);
    viewport.removeEventListener("keydown", onKeyDown);
  };
}

function wheelFactor(deltaY: number): number {
  return deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
}
