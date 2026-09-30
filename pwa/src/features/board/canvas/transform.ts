/**
 * Board camera DOM writes.
 *
 * The only place that measures a viewport and turns a pure camera transition
 * into a style write. Reading the camera and persisting the next one stay with
 * the caller, so this module never touches application state.
 */
import type { TabLayout } from "../../../lib/layout";
import { boardStageSize, cameraTransform, fitCamera, zoomCameraAt, type BoardCamera } from "../model/camera";
import { tileLevel } from "../model/tile-level";

export function applyCameraTransform(stage: HTMLElement, camera: BoardCamera): void {
  stage.style.transform = cameraTransform(camera);
  stage.style.setProperty("--board-control-scale", String(1 / Math.max(0.01, camera.scale)));
  applyTileLevels(stage, camera.scale);
}

/**
 * What each tile draws follows its on-screen size (see model/tile-level). The
 * camera moves at pointer speed without a React render, so the level is a data
 * attribute written here; React never renders it, so a commit cannot undo it,
 * and every commit repaints the transform, which labels freshly mounted tiles.
 */
export function applyTileLevels(stage: HTMLElement, scale: number): void {
  for (const tile of stage.querySelectorAll<HTMLElement>(".board-pane")) {
    const width = parseFloat(tile.style.width) || tile.offsetWidth;
    const height = parseFloat(tile.style.height) || tile.offsetHeight;
    const level = tileLevel(width, height, scale);
    if (tile.dataset.level !== level) tile.dataset.level = level;
  }
}

/** Fit the whole tab into the viewport; the result is a fitted camera. */
export function fitCameraToViewport(viewport: HTMLElement, layout: TabLayout): BoardCamera {
  return fitCamera(viewport.clientWidth, viewport.clientHeight, boardStageSize(layout));
}

/** Zoom around a client point. Null means the clamp rejected the change. */
export function zoomCameraAtPoint(
  camera: BoardCamera,
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
  nextScale: number,
): BoardCamera | null {
  const rect = viewport.getBoundingClientRect();
  return zoomCameraAt(camera, { left: rect.left, top: rect.top }, clientX, clientY, nextScale);
}

export function viewportCenter(viewport: HTMLElement): { x: number; y: number } {
  const rect = viewport.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
