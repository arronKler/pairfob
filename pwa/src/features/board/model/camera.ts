/**
 * Board camera model.
 *
 * Pure geometry: a camera is a value, every transition returns a new one, and
 * nothing here reads the application record or the DOM. The canvas adapter and
 * the page bridge decide when a camera is written and painted.
 */
import { BOARD_CELL_H, BOARD_CELL_W, clampBoardScale, fitBoardCamera, type TabLayout } from "../../../lib/layout";

export type BoardCamera = { scale: number; panX: number; panY: number; fitted: boolean };

export function boardCamera(scale: number, panX: number, panY: number, fitted: boolean): BoardCamera {
  return { scale, panX, panY, fitted };
}

/** Stage-pixel size of a tab layout; the cell is 8×16 like a mono glyph. */
export function boardStageSize(layout: TabLayout): { width: number; height: number } {
  return {
    width: Math.max(120, layout.area.width * BOARD_CELL_W),
    height: Math.max(80, layout.area.height * BOARD_CELL_H),
  };
}

export function cameraTransform(camera: BoardCamera): string {
  return `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.scale})`;
}

/** Fit the whole tab into the viewport and mark the camera as fitted. */
export function fitCamera(
  viewWidth: number,
  viewHeight: number,
  stage: { width: number; height: number },
): BoardCamera {
  const camera = fitBoardCamera(viewWidth, viewHeight, stage.width, stage.height);
  return { scale: camera.scale, panX: camera.panX, panY: camera.panY, fitted: true };
}

/**
 * Zoom around a client point. Returns null when the clamped scale equals the
 * current one, which is the caller's signal to write and repaint nothing.
 */
export function zoomCameraAt(
  camera: BoardCamera,
  origin: { left: number; top: number },
  clientX: number,
  clientY: number,
  nextScale: number,
): BoardCamera | null {
  const scale = clampBoardScale(nextScale);
  if (scale === camera.scale) return null;
  const x = clientX - origin.left;
  const y = clientY - origin.top;
  const sx = (x - camera.panX) / camera.scale;
  const sy = (y - camera.panY) / camera.scale;
  return { scale, panX: x - sx * scale, panY: y - sy * scale, fitted: camera.fitted };
}

export function panCamera(camera: BoardCamera, dx: number, dy: number): BoardCamera {
  return { ...camera, panX: camera.panX + dx, panY: camera.panY + dy };
}

/**
 * Keep the board in its viewport: one rule for both axes and for every input
 * that moves it (a drag, a wheel, two fingers, a zoom, a reveal). On an axis
 * where the stage is larger than the viewport it slides from edge to edge and
 * stops there, so no band of empty canvas opens beside a board that could
 * fill it. Where it is smaller it stays whole inside the viewport and cannot
 * be dragged off; the fit puts it in the middle. A camera already inside comes
 * back as it is; a viewport that cannot be measured bounds nothing.
 */
export function cameraInView(
  camera: BoardCamera,
  viewWidth: number,
  viewHeight: number,
  stage: { width: number; height: number },
): BoardCamera {
  if (!(viewWidth > 0) || !(viewHeight > 0)) return camera;
  const panX = panInView(camera.panX, viewWidth, stage.width * camera.scale);
  const panY = panInView(camera.panY, viewHeight, stage.height * camera.scale);
  return panX === camera.panX && panY === camera.panY ? camera : { ...camera, panX, panY };
}

/**
 * The stage spans `pan … pan + extent`. Larger than the view, its edges stay
 * at or past the view's; smaller, they stay inside them. Either way `pan` lies
 * between 0 and the difference of the two.
 */
function panInView(pan: number, view: number, extent: number): number {
  const room = view - extent;
  return Math.min(Math.max(room, 0), Math.max(Math.min(room, 0), pan));
}

/**
 * How far a vertical wheel still moves the board: the part of the stage that
 * lies past the viewport's edge in the wheel's direction, and no more than the
 * wheel travelled. Positive `deltaY` is a wheel turned down, which brings up
 * what lies below. 0 when that edge is already in view (a board at its fit, or
 * one moved all the way), which leaves the wheel to the pane under it.
 */
export function wheelPanY(
  camera: BoardCamera,
  viewHeight: number,
  stageHeight: number,
  deltaY: number,
): number {
  if (!(viewHeight > 0) || !deltaY) return 0;
  const hidden = deltaY > 0 ? camera.panY + stageHeight * camera.scale - viewHeight : -camera.panY;
  // Less than a pixel is rounding at the fit, not something left to see.
  if (hidden < 1) return 0;
  return deltaY > 0 ? -Math.min(deltaY, hidden) : Math.min(-deltaY, hidden);
}

/**
 * The stage is taller than its viewport: there is board above or below what
 * shows, at one end at least. A pixel of difference is rounding at the fit.
 */
export function stageTallerThanView(camera: BoardCamera, viewHeight: number, stageHeight: number): boolean {
  return viewHeight > 0 && stageHeight * camera.scale - viewHeight >= 1;
}

/** Double-click fill: the scale that makes one tile cover the viewport. */
export function tileFillScale(
  viewWidth: number,
  viewHeight: number,
  boxWidth: number,
  boxHeight: number,
): number {
  return Math.min(viewWidth / Math.max(1, boxWidth), viewHeight / Math.max(1, boxHeight));
}
