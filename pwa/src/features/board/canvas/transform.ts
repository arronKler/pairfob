/**
 * Board camera DOM writes.
 *
 * The only place that measures a viewport and turns a pure camera transition
 * into a style write. Reading the camera and persisting the next one stay with
 * the caller, so this module never touches application state.
 */
import { BOARD_CELL_H, fitBoardCamera, type TabLayout } from "../../../lib/layout";
import {
  boardStageSize,
  cameraInView,
  cameraTransform,
  fitCamera,
  stageTallerThanView,
  wheelPanY,
  zoomCameraAt,
  type BoardCamera,
} from "../model/camera";

/** Title bar height on screen: herdr's one border row, kept between these two. */
export const BOARD_TITLE_MIN_PX = 14;
export const BOARD_TITLE_MAX_PX = 24;

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
  // The bar is herdr's border row: one terminal row tall, so it covers as little
  // of the screen under it as it can, but never unreadably thin or oversized.
  const title = Math.min(BOARD_TITLE_MAX_PX, Math.max(BOARD_TITLE_MIN_PX, BOARD_CELL_H * basis));
  stage.style.setProperty("--board-title-h", `${title}px`);
  // The same bar in stage pixels, as a bare number: what a pane's screen keeps
  // clear under it (`.board-pane-buffer`), where a length cannot be divided.
  stage.style.setProperty("--board-title-clear", String(title / Math.max(0.01, basis)));
}

/** The stage's own size as the canvas wrote it, or null before it has one. */
function stageSize(stage: HTMLElement): { width: number; height: number } | null {
  const width = parseFloat(stage.style.width);
  const height = parseFloat(stage.style.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The scale that fits the whole stage in its viewport, or 0 when it cannot be measured. */
function fitScale(stage: HTMLElement): number {
  const viewport = stage.parentElement;
  const size = stageSize(stage);
  if (!viewport || !size || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return 0;
  return fitBoardCamera(viewport.clientWidth, viewport.clientHeight, size.width, size.height).scale;
}

/** `cameraInView` for the stage on screen. A stage that cannot be measured is left as it is. */
export function cameraWithinViewport(stage: HTMLElement, camera: BoardCamera): BoardCamera {
  const viewport = stage.parentElement;
  const size = stageSize(stage);
  if (!viewport || !size) return camera;
  return cameraInView(camera, viewport.clientWidth, viewport.clientHeight, size);
}

/** `wheelPanY` for the stage on screen. A stage that cannot be measured has nothing to move to. */
export function wheelPanWithinViewport(stage: HTMLElement, camera: BoardCamera, deltaY: number): number {
  const viewport = stage.parentElement;
  const size = stageSize(stage);
  if (!viewport || !size) return 0;
  return wheelPanY(camera, viewport.clientHeight, size.height, deltaY);
}

/** `stageTallerThanView` for the stage on screen. A stage that cannot be measured is taken to fit. */
export function boardTallerThanViewport(stage: HTMLElement, camera: BoardCamera): boolean {
  const viewport = stage.parentElement;
  const size = stageSize(stage);
  if (!viewport || !size) return false;
  return stageTallerThanView(camera, viewport.clientHeight, size.height);
}

/**
 * The one way a camera reaches the screen: bounded to its viewport, handed to
 * `store`, then painted. Every pan, zoom, fit and reveal goes through here, so
 * none of them can slide the board out of sight. Returns what it settled on.
 */
export function settleCamera(stage: HTMLElement, camera: BoardCamera, store: (camera: BoardCamera) => void): BoardCamera {
  const next = cameraWithinViewport(stage, camera);
  store(next);
  applyCameraTransform(stage, next);
  return next;
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
