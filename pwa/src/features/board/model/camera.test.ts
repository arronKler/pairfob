import { describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import {
  boardCamera,
  boardStageSize,
  cameraInView,
  cameraTransform,
  fitCamera,
  panCamera,
  stageTallerThanView,
  tileFillScale,
  wheelPanY,
  zoomCameraAt,
} from "./camera";

const layout: TabLayout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

describe("board stage geometry", () => {
  test("the stage is the layout area in cell pixels, with a usable minimum", () => {
    expect(boardStageSize(layout)).toEqual({ width: 800, height: 640 });
    expect(boardStageSize({ ...layout, area: { x: 0, y: 0, width: 1, height: 1 } })).toEqual({ width: 120, height: 80 });
  });

  test("the transform is exactly what the stage element gets", () => {
    expect(cameraTransform(boardCamera(1.5, -20, 30, true))).toBe("translate(-20px, 30px) scale(1.5)");
  });

  test("a double-click fill covers the viewport from the tile box", () => {
    expect(tileFillScale(400, 200, 100, 50)).toBe(4);
    expect(tileFillScale(400, 200, 0, 0)).toBe(200);
  });
});

describe("board camera transitions", () => {
  test("fitting centres the stage and marks the camera fitted", () => {
    const fitted = fitCamera(800, 600, boardStageSize(layout));
    expect(fitted.fitted).toBe(true);
    expect(fitted.scale).toBeCloseTo(0.875, 5);
    expect(fitted.panX).toBeCloseTo((800 - 800 * fitted.scale) / 2, 5);
    expect(fitted.panY).toBeCloseTo((600 - 640 * fitted.scale) / 2, 5);
  });

  test("a degenerate viewport keeps a usable camera instead of collapsing", () => {
    expect(fitCamera(0, 0, boardStageSize(layout))).toEqual({ scale: 1, panX: 0, panY: 0, fitted: true });
  });

  test("zooming at a point keeps that stage point under the cursor", () => {
    const camera = boardCamera(1, 0, 0, true);
    const origin = { left: 100, top: 50 };
    const next = zoomCameraAt(camera, origin, 300, 250, 2)!;
    expect(next.scale).toBe(2);
    expect(next.fitted).toBe(true);
    // The stage point under (300,250) at scale 1 is (200,200); it must still be there.
    expect((300 - origin.left - next.panX) / next.scale).toBeCloseTo(200, 6);
    expect((250 - origin.top - next.panY) / next.scale).toBeCloseTo(200, 6);
  });

  test("a clamped zoom writes nothing, so a repaint is not invented", () => {
    const camera = boardCamera(1, 10, 10, false);
    expect(zoomCameraAt(camera, { left: 0, top: 0 }, 50, 50, 1)).toBeNull();
    expect(zoomCameraAt(camera, { left: 0, top: 0 }, 50, 50, Number.NaN)).toBeNull();
    expect(zoomCameraAt(camera, { left: 0, top: 0 }, 50, 50, 1e6)?.scale).toBe(4);
    expect(zoomCameraAt(camera, { left: 0, top: 0 }, 50, 50, -5)?.scale).toBe(0.12);
    expect(zoomCameraAt(camera, { left: 0, top: 0 }, 50, 50, 1e6)?.fitted).toBe(false);
  });

  test("panning translates and keeps scale and fit", () => {
    const camera = boardCamera(1.4, 12, -8, true);
    expect(panCamera(camera, 30, -4)).toEqual({ scale: 1.4, panX: 42, panY: -12, fitted: true });
    expect(camera).toEqual({ scale: 1.4, panX: 12, panY: -8, fitted: true });
  });
});

describe("the board stays in view", () => {
  const stage = { width: 800, height: 640 };

  test("a board that fits stays whole inside the viewport, wherever it is pushed", () => {
    // 800×600 viewport, stage 680×544 at 0.85: the fit sits at (60, 28).
    const fit = boardCamera(0.85, 60, 28, true);
    expect(cameraInView(fit, 800, 600, stage)).toBe(fit);
    // Six sideways wheels would have slid it half out; it stops with its edge at the viewport's.
    expect(cameraInView(panCamera(fit, -1200, 0), 800, 600, stage)).toEqual({ ...fit, panX: 0 });
    expect(cameraInView(panCamera(fit, 1600, 0), 800, 600, stage)).toEqual({ ...fit, panX: 800 - 680 });
    expect(cameraInView(panCamera(fit, 0, -5000), 800, 600, stage).panY).toBe(0);
    expect(cameraInView(panCamera(fit, 0, 5000), 800, 600, stage).panY).toBe(600 - 544);
  });

  test("a board zoomed past the viewport pans from edge to edge and no further", () => {
    // 3200×2560 on screen: both far corners can be brought fully into the 800×600 viewport.
    const zoomed = boardCamera(4, 0, 0, false);
    expect(cameraInView(zoomed, 800, 600, stage)).toBe(zoomed);
    const farCorner = boardCamera(4, 800 - 3200, 600 - 2560, false);
    expect(cameraInView(farCorner, 800, 600, stage)).toBe(farCorner);
    // Pushed past either corner it stops there: no band of empty canvas on any side.
    expect(cameraInView(panCamera(zoomed, 400, 300), 800, 600, stage)).toEqual(zoomed);
    expect(cameraInView(panCamera(farCorner, -400, -300), 800, 600, stage)).toEqual(farCorner);
  });

  test("each axis is bounded on its own: wider than the viewport, shorter than it", () => {
    // 800×640 at 1.25 is 1000×800 in a 800×900 viewport.
    const wide = boardCamera(1.25, 0, 50, false);
    expect(cameraInView(panCamera(wide, -5000, -5000), 800, 900, stage)).toEqual({ ...wide, panX: 800 - 1000, panY: 0 });
    expect(cameraInView(panCamera(wide, 5000, 5000), 800, 900, stage)).toEqual({ ...wide, panX: 0, panY: 900 - 800 });
  });

  test("a small board cannot be dragged off", () => {
    const small = cameraInView(boardCamera(0.12, -500, 900, false), 800, 600, stage);
    expect(small.panX).toBe(0);
    expect(small.panY).toBeCloseTo(600 - 640 * 0.12, 6);
    const other = cameraInView(boardCamera(0.12, 5000, -900, false), 800, 600, stage);
    expect(other.panX).toBeCloseTo(800 - 96, 6);
    expect(other.panY).toBe(0);
  });

  test("a viewport that cannot be measured bounds nothing", () => {
    const adrift = boardCamera(1, -9000, 9000, true);
    expect(cameraInView(adrift, 0, 0, stage)).toBe(adrift);
  });
});

describe("a vertical wheel on a board that reaches past its window", () => {
  // 800×640 at 2×: 1280px tall in a 600px window, the top 100px above it.
  const zoomed = boardCamera(2, -300, -100, true);

  test("it moves the board by its travel towards the hidden part", () => {
    // Wheel down brings up what lies below: the stage moves up.
    expect(wheelPanY(zoomed, 600, 640, 120)).toBe(-120);
    expect(wheelPanY(zoomed, 600, 640, -60)).toBe(60);
  });

  test("it stops with the board's edge at the window's edge, not past it", () => {
    // 580px lie below the window, 100px above it.
    expect(wheelPanY(zoomed, 600, 640, 900)).toBe(-580);
    expect(wheelPanY(zoomed, 600, 640, -900)).toBe(100);
    expect(wheelPanY(boardCamera(2, -300, 600 - 1280, true), 600, 640, 120)).toBe(0);
    expect(wheelPanY(boardCamera(2, -300, 0, true), 600, 640, -120)).toBe(0);
  });

  test("a board that fits has nowhere to go, wherever it was slid, and neither has an unmeasured window", () => {
    const fit = fitCamera(800, 600, { width: 800, height: 640 });
    expect(wheelPanY(fit, 600, 640, 120)).toBe(0);
    expect(wheelPanY(fit, 600, 640, -120)).toBe(0);
    // Slid down inside the window: its top edge is in view, so a wheel up moves nothing.
    expect(wheelPanY(panCamera(fit, 0, 20), 600, 640, -120)).toBe(0);
    expect(wheelPanY(zoomed, 0, 640, 120)).toBe(0);
    expect(wheelPanY(zoomed, 600, 640, 0)).toBe(0);
  });
});

describe("a board taller than its window", () => {
  test("is one whose stage, as zoomed, does not fit the window's height, wherever it was moved", () => {
    expect(stageTallerThanView(boardCamera(2, -300, -100, true), 600, 640)).toBe(true);
    expect(stageTallerThanView(boardCamera(2, -300, 600 - 1280, true), 600, 640)).toBe(true);
    // Wider than the window only: its whole height shows.
    expect(stageTallerThanView(boardCamera(1.25, -100, 50, true), 900, 640)).toBe(false);
  });

  test("the fit is not, rounding included, and neither is an unmeasured window", () => {
    const fit = fitCamera(800, 600, { width: 800, height: 640 });
    expect(stageTallerThanView(fit, 600, 640)).toBe(false);
    expect(stageTallerThanView(boardCamera(600.5 / 640, 0, 0, true), 600, 640)).toBe(false);
    expect(stageTallerThanView(boardCamera(2, 0, 0, true), 0, 640)).toBe(false);
  });
});
