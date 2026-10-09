import { resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, expect, test } from "bun:test";
import { fitPreviewBuffer } from "./font";

/**
 * The fit is handed to the styles as numbers, not written as a transform: the
 * room a pane's ring needs is taken off it there and follows the camera.
 */
beforeEach(resetBoardTestDOM);

function screen(cell: { width: number; height: number }, grid: { width: number; height: number }) {
  const host = document.createElement("span");
  const buffer = document.createElement("div");
  buffer.className = "board-pane-buffer";
  host.append(buffer);
  document.body.append(host);
  Object.defineProperty(host, "clientWidth", { configurable: true, value: cell.width });
  Object.defineProperty(host, "clientHeight", { configurable: true, value: cell.height });
  Object.defineProperty(buffer, "offsetWidth", { configurable: true, value: grid.width });
  Object.defineProperty(buffer, "offsetHeight", { configurable: true, value: grid.height });
  return { host, buffer };
}

test("the buffer is told its fit by width and by height and the cell's size; the transform is the styles'", () => {
  // An 80×24 grid (640×384) in a cell half a pixel narrower on each side for its seam.
  const { host, buffer } = screen({ width: 639, height: 383 }, { width: 640, height: 384 });
  fitPreviewBuffer(host);
  expect(Number(buffer.style.getPropertyValue("--board-preview-fit-width"))).toBeCloseTo(639 / 640, 9);
  expect(Number(buffer.style.getPropertyValue("--board-preview-fit-height"))).toBeCloseTo(383 / 384, 9);
  expect(buffer.style.getPropertyValue("--board-preview-width")).toBe("639");
  expect(buffer.style.getPropertyValue("--board-preview-height")).toBe("383");
  expect(buffer.style.transform).toBe("");
});

test("a cell that cannot be measured leaves the buffer at the styles' own fit", () => {
  const { host, buffer } = screen({ width: 639, height: 383 }, { width: 640, height: 384 });
  fitPreviewBuffer(host);
  Object.defineProperty(host, "clientWidth", { configurable: true, value: 0 });
  fitPreviewBuffer(host);
  for (const property of ["--board-preview-fit-width", "--board-preview-fit-height", "--board-preview-width", "--board-preview-height"]) {
    expect(buffer.style.getPropertyValue(property)).toBe("");
  }
});
