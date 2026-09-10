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

/** Double-click fill: the scale that makes one tile cover the viewport. */
export function tileFillScale(
  viewWidth: number,
  viewHeight: number,
  boxWidth: number,
  boxHeight: number,
): number {
  return Math.min(viewWidth / Math.max(1, boxWidth), viewHeight / Math.max(1, boxHeight));
}
