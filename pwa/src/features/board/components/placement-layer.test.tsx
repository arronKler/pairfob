import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useRef } from "react";
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection, SplitDirection } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { boardInteractionStore, clearBoardInteraction, startBoardPlacement } from "../interaction-store";
import type { BoardCanvasController } from "./canvas-controller";
import { PlacementLayer } from "./placement-layer";

// wide | narrow (12 cols) over short (6 rows)
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "wide",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [
    { paneId: "wide", focused: true, rect: { x: 0, y: 0, width: 88, height: 40 } },
    { paneId: "narrow", focused: false, rect: { x: 88, y: 0, width: 12, height: 34 } },
    { paneId: "short", focused: false, rect: { x: 88, y: 34, width: 12, height: 6 } },
  ],
};

beforeEach(async () => { await resetBoardTestDOM(); clearBoardInteraction(); });
afterEach(() => { unmountReact(); clearBoardInteraction(); });

function rig(current: TabLayout = layout) {
  const calls: string[] = [];
  const controller = {
    pickSplit: (id: string, direction: SplitDirection) => calls.push(`split ${id} ${direction}`),
    commitSwap: async (id: string, direction: LayoutDirection) => { calls.push(`swap ${id} ${direction}`); },
  } as unknown as BoardCanvasController;
  function Host({ value }: { value: TabLayout }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    return <div ref={viewportRef} className="board-canvas"><div className="board-stage">
      <PlacementLayer layout={value} controller={controller} viewportRef={viewportRef} />
    </div></div>;
  }
  const render = (value = current) => renderReact(<Host value={value} />);
  render();
  const click = (selector: string) => act(() => { document.querySelector<HTMLElement>(selector)!.click(); });
  const placement = () => boardInteractionStore.get().placementKind;
  return { calls, render, click, placement };
}

test("nothing is drawn until the menu starts a placement", () => {
  rig();
  expect(document.querySelector(".board-place-banner, .board-place-ghost, .board-place-target")).toBeNull();
});

test("split: two ghosts on a roomy pane, the pick hands over to the split sheet and ends placement", () => {
  const r = rig();
  act(() => startBoardPlacement("split", "wide", "w1:t1"));
  const ghosts = [...document.querySelectorAll<HTMLElement>(".board-place-ghost")];
  expect(ghosts.map((ghost) => ghost.getAttribute("aria-label"))).toEqual([t("boardCanvas.placeRight"), t("boardCanvas.placeDown")]);
  expect(document.querySelectorAll(".board-place-dim")).toHaveLength(2);
  expect(document.querySelector(".board-place-banner")?.textContent).toContain(t("boardCanvas.placeSplit"));
  act(() => ghosts[0].click());
  expect(r.calls).toEqual(["split wide right"]);
  expect(r.placement()).toBe("");
});

test("split: a side too small to halve is not offered, and the banner says why", () => {
  rig();
  act(() => startBoardPlacement("split", "narrow", "w1:t1"));
  expect([...document.querySelectorAll(".board-place-ghost")].map((ghost) => ghost.getAttribute("aria-label")))
    .toEqual([t("boardCanvas.placeDown")]);
  expect(document.querySelector(".board-place-banner")?.textContent).toContain(t("boardCanvas.placeNarrow"));
});

test("swap: only touching panes are targets, labelled with the direction the request names", () => {
  const r = rig();
  act(() => startBoardPlacement("swap", "narrow", "w1:t1"));
  const targets = [...document.querySelectorAll<HTMLElement>(".board-place-target")];
  expect(targets.map((target) => target.textContent)).toEqual([t("boardCanvas.liftLeft"), t("boardCanvas.liftDown")]);
  act(() => targets[1].click());
  expect(r.calls).toEqual(["swap narrow down"]);
  expect(r.placement()).toBe("");
});

test("Cancel or Escape leaves placement without acting (a canvas tap is the gesture adapter's)", () => {
  const r = rig();
  act(() => startBoardPlacement("split", "wide", "w1:t1"));
  r.click(".board-place-banner button");
  expect(r.placement()).toBe("");
  act(() => startBoardPlacement("swap", "wide", "w1:t1"));
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(r.placement()).toBe("");
  expect(r.calls).toEqual([]);
});

test("placement ends by itself when its pane leaves or the tab is another one", () => {
  const r = rig();
  act(() => startBoardPlacement("split", "short", "w1:t1"));
  expect(r.placement()).toBe("split");
  act(() => r.render({ ...layout, panes: layout.panes.slice(0, 2) }));
  expect(r.placement()).toBe("");
  act(() => startBoardPlacement("split", "wide", "w1:t9"));
  expect(r.placement()).toBe("");
});
