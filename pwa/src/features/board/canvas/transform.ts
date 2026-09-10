/**
 * Board camera DOM writes.
 *
 * The only place that measures a viewport and turns a pure camera transition
 * into a style write. Reading the camera and persisting the next one stay with
 * the caller, so this module never touches application state.
 */
import type { TabLayout } from "../../../lib/layout";
import { boardStageSize, cameraTransform, fitCamera, zoomCameraAt, type BoardCamera } from "../model/camera";

export function applyCameraTransform(stage: HTMLElement, camera: BoardCamera): void {
  stage.style.transform = cameraTransform(camera);
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
