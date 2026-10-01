/**
 * Board camera DOM writes.
 *
 * The only place that measures a viewport and turns a pure camera transition
 * into a style write. Reading the camera and persisting the next one stay with
 * the caller, so this module never touches application state.
 */
import { fitBoardCamera, type TabLayout } from "../../../lib/layout";
import { boardStageSize, cameraTransform, fitCamera, zoomCameraAt, type BoardCamera } from "../model/camera";

export function applyCameraTransform(stage: HTMLElement, camera: BoardCamera): void {
  stage.style.transform = cameraTransform(camera);
  // Pane screens scale with the stage like herdr's own miniature. Controls
  // (handles, hints) counter-scale to keep their on-screen size at any zoom.
  stage.style.setProperty("--board-control-scale", String(1 / Math.max(0.01, camera.scale)));
  // Pane chrome (title bars) stays readable from the fit upwards, but below the
  // fit it shrinks with the screens, so zooming out never buries them under bars.
  const fit = fitScale(stage);
  const basis = fit > 0 ? Math.max(camera.scale, fit) : camera.scale;
  stage.style.setProperty("--board-chrome-scale", String(1 / Math.max(0.01, basis)));
}

/** The scale that fits the whole stage in its viewport, or 0 when it cannot be measured. */
function fitScale(stage: HTMLElement): number {
  const viewport = stage.parentElement;
  const width = parseFloat(stage.style.width);
  const height = parseFloat(stage.style.height);
  if (!viewport || !(width > 0) || !(height > 0) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return 0;
  return fitBoardCamera(viewport.clientWidth, viewport.clientHeight, width, height).scale;
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
