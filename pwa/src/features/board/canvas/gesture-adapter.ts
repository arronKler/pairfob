/**
 * Board canvas gesture adapter.
 *
 * Owns the whole pointer lifetime of the board canvas: capture, the slop that
 * separates a tap from a drag, pan vs pane-scroll vs two-finger pinch, wheel
 * zoom and remote scroll, the tap synthesis that a prevented gesture still
 * owes the tile, and the click suppression that keeps a finished drag from
 * reopening a pane. Everything stateful lives in `BoardCanvasPorts`, so this
 * module is the same code on the legacy record and on a domain store, and
 * disposing it retires every listener, frame and in-flight gesture.
 */
import type { TabLayout } from "../../../lib/layout";
import { boardDragMode, boardScrollLines, BOARD_GESTURE_SLOP_PX } from "../model/gesture";
import { panCamera, type BoardCamera } from "../model/camera";
import { applyCameraTransform, fitCameraToViewport, zoomCameraAtPoint } from "./transform";

export type BoardCanvasPorts = {
  readCamera(): BoardCamera;
  writeCamera(camera: BoardCamera): void;
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
};

const WHEEL_ZOOM_FACTOR = 1.08;

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
    const fitted = fitCameraToViewport(viewport, layout);
    ports.writeCamera(fitted);
    applyCameraTransform(stage, fitted);
  });

  const pointers = new Map<number, { x: number; y: number }>();
  let origin = { x: 0, y: 0 };
  let hitPane = "";
  let mode: "undecided" | "pan" | "scroll" | "pinch" = "undecided";
  let moved = false;
  let pinch = 0;
  let scrollRemainder = 0;

  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });

  function writeCamera(camera: BoardCamera): void {
    ports.writeCamera(camera);
    applyCameraTransform(stage, camera);
  }

  function zoomAt(clientX: number, clientY: number, nextScale: number): void {
    const next = zoomCameraAtPoint(ports.readCamera(), viewport, clientX, clientY, nextScale);
    if (next) writeCamera(next);
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
    const next = point(event);
    pointers.set(event.pointerId, next);
    origin = next;
    hitPane = paneIdFromEvent(event);
    moved = false;
    mode = "undecided";
    scrollRemainder = 0;
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom/happy-dom may not implement capture */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      mode = "pinch";
      hitPane = "";
    }
    if (event.pointerType === "touch" || event.pointerType === "pen") event.preventDefault();
  };

  const onMove = (event: PointerEvent) => {
    if (retired || !pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId)!;
    const next = point(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 2) {
      mode = "pinch";
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && dist > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, ports.readCamera().scale * (dist / pinch));
        pinch = dist;
        moved = true;
      }
      event.preventDefault();
      return;
    }
    const fromOriginX = next.x - origin.x;
    const fromOriginY = next.y - origin.y;
    if (mode === "undecided") {
      if (Math.hypot(fromOriginX, fromOriginY) < BOARD_GESTURE_SLOP_PX) return;
      mode = boardDragMode(fromOriginX, fromOriginY, hitPane);
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
    if (retired) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 0) {
      // A gesture that never moved is a tap: hand it to the tile it started on.
      if (!moved && hitPane) {
        for (const tile of viewport.querySelectorAll<HTMLButtonElement>(".board-pane")) {
          if (tile.dataset.paneId !== hitPane) continue;
          tile.click();
          break;
        }
      }
      if (mode === "scroll" && hitPane) ports.requestPanePreview(hitPane);
      mode = "undecided";
    }
    if (moved) event.preventDefault();
  };

  const onWheel = (event: WheelEvent) => {
    if (retired) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, ports.readCamera().scale * wheelFactor(event.deltaY));
      return;
    }
    const paneId = paneIdFromEvent(event);
    if (paneId) {
      event.preventDefault();
      const stepped = boardScrollLines(scrollRemainder, -event.deltaY);
      scrollRemainder = stepped.remainder;
      if (stepped.lines) scrollPane(paneId, stepped.direction, stepped.lines);
      return;
    }
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, ports.readCamera().scale * wheelFactor(event.deltaY));
  };

  const onClick = (event: MouseEvent) => {
    if (retired || !moved) return;
    event.preventDefault();
    event.stopPropagation();
  };

  viewport.addEventListener("pointerdown", onDown, { capture: true, passive: false });
  viewport.addEventListener("pointermove", onMove, { capture: true, passive: false });
  viewport.addEventListener("pointerup", end, true);
  viewport.addEventListener("pointercancel", end, true);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("click", onClick, true);

  return () => {
    retired = true;
    cancelAnimationFrame(frame);
    viewport.removeEventListener("pointerdown", onDown, true);
    viewport.removeEventListener("pointermove", onMove, true);
    viewport.removeEventListener("pointerup", end, true);
    viewport.removeEventListener("pointercancel", end, true);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("click", onClick, true);
  };
}

function wheelFactor(deltaY: number): number {
  return deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
}
