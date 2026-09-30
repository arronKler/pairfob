import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useRef } from "react";
import type { TabLayout } from "../../../lib/layout";
import type { ResizePaneInput } from "../../../lib/operations";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { layoutDraft, setLayoutDraft } from "../model/draft-store";
import type { BoardCanvasController, BoardLayoutKind } from "./canvas-controller";
import { DividerHandles, type ViewportPoint } from "./divider-handles";

// p1 | p2 split at 60 of 100 cells; with the test DOM the stage sits at 0,0 unscaled,
// so one cell is 8 px across and 16 px down.
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [
    { paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { paneId: "p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
  ],
  splits: [{ id: "root", direction: "right", ratio: 0.6, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

beforeEach(async () => { await resetBoardTestDOM(); setLayoutDraft(null); });
afterEach(() => { unmountReact(); setLayoutDraft(null); });

function rig(reasons: Partial<Record<BoardLayoutKind, string>> = {}, enabled = true) {
  const requests: ResizePaneInput[] = [];
  const sheets: string[] = [];
  const hints: Array<{ text: string; point: ViewportPoint }> = [];
  let settle: () => void = () => {};
  const controller = {
    layoutReason: (kind: BoardLayoutKind) => reasons[kind] ?? "",
    commitResize: (request: ResizePaneInput) => { requests.push(request); return new Promise<void>((resolve) => { settle = resolve; }); },
    openResizeSheet: (paneId: string) => sheets.push(paneId),
  } as unknown as BoardCanvasController;
  function Host({ signature }: { signature: string }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    return <div ref={viewportRef} className="board-canvas"><div ref={stageRef} className="board-stage">
      <DividerHandles layout={layout} signature={signature} enabled={enabled} controller={controller} viewportRef={viewportRef}
        stageRef={stageRef} onHint={(text, point) => hints.push({ text, point })} />
    </div></div>;
  }
  const render = (signature = "s1") => renderReact(<Host signature={signature} />);
  render();
  const handle = () => document.querySelector<HTMLElement>(".board-divider")!;
  const pointer = (type: string, clientX: number, extra: PointerEventInit = {}) => act(() => {
    handle().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch",
      button: 0, clientX, clientY: 100, ...extra }));
  });
  return { requests, sheets, hints, handle, pointer, render, settle: () => act(async () => { settle(); await Promise.resolve(); }) };
}

test("one handle per herdr split, placed on the line, labelled as a slider", () => {
  const r = rig();
  const handle = r.handle();
  expect(document.querySelectorAll(".board-divider")).toHaveLength(1);
  expect(handle.style.left).toBe("480px");
  expect(handle.getAttribute("role")).toBe("slider");
  expect(handle.getAttribute("aria-valuenow")).toBe("60");
  expect(handle.dataset.boardOverlay).toBe("");
});

test("a drag keeps the grab offset, previews on whole cells, and commits the herdr request once", async () => {
  const r = rig();
  r.pointer("pointerdown", 484); // half a cell right of the line: pressing must not move it
  expect(layoutDraft()).toBeNull();
  r.pointer("pointermove", 486);
  expect(layoutDraft()).toBeNull();
  r.pointer("pointermove", 564); // +10 cells
  expect(layoutDraft()).toEqual({ tabId: "w1:t1", splitId: "root", ratio: 0.7, pending: false });
  expect(document.querySelector(".board-drag-bubble")?.textContent).toContain("70");
  r.pointer("pointerup", 564);
  expect(r.requests).toHaveLength(1);
  expect(r.requests[0]).toMatchObject({ pane_id: "p1", direction: "right" });
  expect(r.requests[0].amount).toBeCloseTo(0.1, 9);
  expect(layoutDraft()).toMatchObject({ splitId: "root", pending: true });
  expect(document.querySelector(".board-drag-bubble")).toBeNull();
  await r.settle();
  expect(layoutDraft()).toBeNull();
});

test("moving left names the pane on the other side of the line", () => {
  const r = rig();
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 400);
  r.pointer("pointerup", 400);
  expect(r.requests[0]).toMatchObject({ pane_id: "p2", direction: "left" });
});

test("a release on the same cell is a tap: the stepper opens for the first-side pane", () => {
  const r = rig();
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 482);
  r.pointer("pointerup", 482);
  expect(r.requests).toEqual([]);
  expect(r.sheets).toEqual(["p1"]);
  expect(layoutDraft()).toBeNull();
});

test("a swipe that starts on a line and comes back to the same cell is neither a tap nor a resize", () => {
  const r = rig();
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 480, { clientY: 160 });
  r.pointer("pointerup", 480, { clientY: 160 });
  expect(r.sheets).toEqual([]);
  expect(r.requests).toEqual([]);
});

test("a finger that joins a pinch never starts a drag", () => {
  const r = rig();
  const viewport = document.querySelector<HTMLElement>(".board-canvas")!;
  act(() => { viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, pointerType: "touch", clientX: 10, clientY: 10 })); });
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 560);
  r.pointer("pointerup", 560);
  expect(r.requests).toEqual([]);
  expect(layoutDraft()).toBeNull();
});

test("without resize_pane (or on a stand-in layout) there are no handles at all", () => {
  rig({}, false);
  expect(document.querySelector(".board-divider")).toBeNull();
});

test("cancel, a second finger and a layout change all drop the drag without a request", () => {
  const r = rig();
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 560);
  r.pointer("pointercancel", 560);
  expect(layoutDraft()).toBeNull();

  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 560);
  act(() => { document.querySelector(".board-canvas")!.dispatchEvent(new PointerEvent("pointerdown",
    { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch", clientX: 10, clientY: 10 })); });
  expect(layoutDraft()).toBeNull();
  r.pointer("pointerup", 560);

  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 560);
  r.render("s2");
  expect(layoutDraft()).toBeNull();
  r.pointer("pointerup", 560);
  expect(r.requests).toEqual([]);
});

test("a locked divider explains itself and never starts a drag", () => {
  const r = rig({ resize: "Reconnecting" });
  expect(r.handle().classList.contains("is-locked")).toBeTrue();
  r.pointer("pointerdown", 480);
  r.pointer("pointermove", 560);
  r.pointer("pointerup", 560);
  expect(r.hints.map((hint) => hint.text)).toEqual(["Reconnecting"]);
  expect(r.requests).toEqual([]);
  expect(layoutDraft()).toBeNull();
});

test("arrow keys on a focused handle move the line one herdr step", () => {
  const r = rig();
  act(() => { r.handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
  expect(r.requests[0]).toMatchObject({ pane_id: "p2", direction: "left" });
  expect(r.requests[0].amount).toBeCloseTo(0.05, 9);
  act(() => { r.handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  expect(r.requests).toHaveLength(1);
});
