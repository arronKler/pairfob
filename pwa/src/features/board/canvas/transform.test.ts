import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fitBoardCamera } from "../../../lib/layout";
import { boardCamera } from "../model/camera";
import { applyCameraTransform } from "./transform";

beforeEach(resetBoardTestDOM);
afterEach(() => { for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); });

function rig(viewWidth: number, viewHeight: number) {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientWidth", { value: viewWidth });
  Object.defineProperty(viewport, "clientHeight", { value: viewHeight });
  const stage = document.createElement("div");
  stage.style.width = "1600px";
  stage.style.height = "640px";
  viewport.append(stage);
  document.body.append(viewport);
  return stage;
}

const read = (stage: HTMLElement, name: string) => Number(stage.style.getPropertyValue(name));

test("controls keep their screen size at every zoom; title bars only from the fit up", () => {
  const stage = rig(390, 500);
  const fit = fitBoardCamera(390, 500, 1600, 640).scale;
  // Zoomed in past the fit: both counter-scale.
  applyCameraTransform(stage, boardCamera(fit * 2, 0, 0, false));
  expect(read(stage, "--board-control-scale")).toBeCloseTo(1 / (fit * 2), 6);
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(1 / (fit * 2), 6);
  // Zoomed out below the fit: title bars stop counter-scaling and shrink with the screens.
  applyCameraTransform(stage, boardCamera(fit / 3, 0, 0, false));
  expect(read(stage, "--board-control-scale")).toBeCloseTo(3 / fit, 6);
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(1 / fit, 6);
});

test("a stage that cannot be measured keeps the plain counter-scale", () => {
  const stage = rig(0, 0);
  applyCameraTransform(stage, boardCamera(0.2, 0, 0, false));
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(5, 6);
});
