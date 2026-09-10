import { describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import {
  boardCamera,
  boardStageSize,
  cameraTransform,
  fitCamera,
  panCamera,
  tileFillScale,
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
