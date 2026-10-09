import { expectSameNode } from "../../../../test-support/node-identity";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useRef } from "react";
import type { TabLayout } from "../../../lib/layout";
import type { ResizePaneInput } from "../../../lib/operations";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { layoutDraft, setLayoutDraft } from "../model/draft-store";
import type { BoardCanvasController, BoardLayoutKind } from "./canvas-controller";
import { DividerHandles } from "./divider-handles";

/**
 * The divider band runs over the corner where a pane's ⋯ sits. A browser aims
 * a finger at the band there although the ⋯ is drawn on top, so the band hands
 * a tap inside the ⋯'s target to the pane menu and keeps everything else.
 */
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [
    { paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { paneId: "p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
  ],
  splits: [{ id: "root", direction: "right", ratio: 0.6, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

/** The ⋯ target of p1 in this rig: the 44px left of the line at x=480, 44px down from the top. */
const inMore = (x: number, y: number) => x >= 436 && x < 480 && y >= 0 && y < 44;
let realElementsFromPoint: typeof document.elementsFromPoint;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLayoutDraft(null);
  realElementsFromPoint = document.elementsFromPoint;
  // What is drawn at a point: the ⋯ (its slop included) above the band, then the band.
  document.elementsFromPoint = (x: number, y: number) => [
    ...(inMore(x, y) ? [document.querySelector(".board-pane-more")!] : []),
    document.querySelector(".board-divider")!,
  ];
});
afterEach(() => { unmountReact(); setLayoutDraft(null); document.elementsFromPoint = realElementsFromPoint; });

function rig(reasons: Partial<Record<BoardLayoutKind, string>> = {}) {
  const requests: ResizePaneInput[] = [];
  const sheets: string[] = [];
  const menus: Array<{ paneId: string; tile: HTMLElement }> = [];
  const hints: string[] = [];
  const controller = {
    layoutReason: (kind: BoardLayoutKind) => reasons[kind] ?? "",
    commitResize: (request: ResizePaneInput) => { requests.push(request); return new Promise<void>(() => {}); },
    openResizeSheet: (paneId: string) => sheets.push(paneId),
    openMenu: (paneId: string, _point: unknown, tile: HTMLElement) => menus.push({ paneId, tile }),
  } as unknown as BoardCanvasController;
  function Host() {
    const viewportRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    return <div ref={viewportRef} className="board-canvas"><div ref={stageRef} className="board-stage">
      <div className="board-pane" data-pane-id="p1"><button className="board-pane-more" /></div>
      <DividerHandles layout={layout} signature="s1" enabled controller={controller} viewportRef={viewportRef}
        stageRef={stageRef} onHint={(text) => hints.push(text)} />
    </div></div>;
  }
  renderReact(<Host />);
  const handle = () => document.querySelector<HTMLElement>(".board-divider")!;
  const pointer = (type: string, clientX: number, clientY: number) => act(() => {
    handle().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, clientX, clientY }));
  });
  const tap = (x: number, y: number) => { pointer("pointerdown", x, y); pointer("pointerup", x, y); };
  return { requests, sheets, menus, hints, pointer, tap };
}

/** The click a browser sends after a touch release, wherever it lands. */
function trailingClick(target: Element): MouseEvent {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
  target.dispatchEvent(click);
  return click;
}

test("a tap the band received inside a pane's ⋯ target opens that pane's menu, not the stepper", () => {
  const r = rig();
  r.tap(476, 30);
  expect(r.menus.map((menu) => menu.paneId)).toEqual(["p1"]);
  expectSameNode(r.menus[0].tile, document.querySelector<HTMLElement>(".board-pane")!);
  expect(r.sheets).toEqual([]);
  expect(r.requests).toEqual([]);
  expect(layoutDraft()).toBeNull();
});

test("the band beside and below the target keeps its own tap", () => {
  const r = rig();
  r.tap(484, 30); // right of the line: the neighbour's side of the band
  r.tap(476, 60); // under the 44px target
  expect(r.menus).toEqual([]);
  expect(r.sheets).toEqual(["p1", "p1"]);
});

test("a drag that starts inside the target still moves the divider", () => {
  const r = rig();
  r.pointer("pointerdown", 476, 30);
  r.pointer("pointermove", 556, 30);
  expect(layoutDraft()).toMatchObject({ splitId: "root", pending: false });
  r.pointer("pointerup", 556, 30);
  expect(r.requests).toHaveLength(1);
  expect(r.menus).toEqual([]);
});

test("the sheet a tap opened is not pressed by that tap's own click", () => {
  const r = rig();
  const row = document.createElement("button");
  let pressed = 0;
  row.addEventListener("click", () => { pressed += 1; });
  document.body.append(row);
  try {
    // Either sheet comes up under the finger before the browser's click.
    r.tap(476, 30);
    expect(trailingClick(row).defaultPrevented).toBeTrue();
    r.tap(484, 30);
    expect(trailingClick(row).defaultPrevented).toBeTrue();
    expect(pressed).toBe(0);
    // Only that click: after the next press the row is the reader's.
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
    expect(trailingClick(row).defaultPrevented).toBeFalse();
    expect(pressed).toBe(1);
  } finally { row.remove(); }
});

test("a divider that cannot move still hands the ⋯ its tap, and explains itself everywhere else", () => {
  const r = rig({ resize: "Reconnecting" });
  r.tap(476, 30);
  expect(r.menus.map((menu) => menu.paneId)).toEqual(["p1"]);
  expect(r.hints).toEqual([]);
  // A drag from there moves nothing and opens nothing.
  r.pointer("pointerdown", 476, 30);
  r.pointer("pointermove", 556, 30);
  expect(layoutDraft()).toBeNull();
  r.pointer("pointerup", 556, 30);
  expect(r.menus).toHaveLength(1);
  expect(r.requests).toEqual([]);
  r.tap(484, 30);
  expect(r.hints).toEqual(["Reconnecting"]);
  expect(r.sheets).toEqual([]);
});
