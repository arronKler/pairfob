import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { state } from "../../state";
import { bindBoardCanvasGestures } from "../board-canvas";

const layout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 10, height: 10 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 10, height: 10 } }],
};

beforeEach(resetBoardTestDOM);

function harness(): { viewport: HTMLDivElement; clicks: () => number; stop: () => void } {
  const viewport = document.createElement("div");
  viewport.className = "board-pane";
  viewport.dataset.paneId = "w1:p1";
  const stage = document.createElement("div");
  const tile = document.createElement("button");
  tile.className = "board-pane";
  tile.dataset.paneId = "w1:p1";
  let clicks = 0;
  tile.addEventListener("click", () => {
    clicks += 1;
  });
  stage.append(tile);
  viewport.append(stage);
  document.body.append(viewport);
  const stop = bindBoardCanvasGestures(viewport, stage, layout);
  return { viewport, clicks: () => clicks, stop };
}

function tap(viewport: HTMLElement): void {
  const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 4, clientY: 4 });
  const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 4, clientY: 4 });
  viewport.dispatchEvent(down);
  viewport.dispatchEvent(up);
}

afterEach(() => {
  state.boardScale = 1;
  state.boardPanX = 0;
  state.boardPanY = 0;
  state.paneId = "";
  state.screen = "home";
});

describe("react board canvas gestures", () => {
  test("retired bindings emit no late tile clicks", () => {
    const { viewport, clicks, stop } = harness();
    stop();
    tap(viewport);
    expect(clicks()).toBe(0);
    viewport.remove();
  });

  test("a live binding still synthesizes a tap click before cleanup", () => {
    const { viewport, clicks, stop } = harness();
    tap(viewport);
    expect(clicks()).toBe(1);
    stop();
    tap(viewport);
    expect(clicks()).toBe(1);
    viewport.remove();
  });
});
