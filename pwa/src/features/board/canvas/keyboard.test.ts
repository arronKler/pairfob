import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection, ResizePaneInput, SplitDirection } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import type { BoardCanvasController, BoardLayoutKind } from "../components/canvas-controller";
import { layoutDraft, setLayoutDraft, type LayoutDraft } from "../model/draft-store";
import { bindBoardKeyboard, boardKeyCommand } from "./keyboard";

// a | b over c, herdr's own numbers; b is the computer's focused pane.
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "b",
  area: { x: 0, y: 0, width: 213, height: 72 },
  panes: [
    { paneId: "a", focused: false, rect: { x: 0, y: 0, width: 110, height: 72 } },
    { paneId: "b", focused: true, rect: { x: 110, y: 0, width: 103, height: 40 } },
    { paneId: "c", focused: false, rect: { x: 110, y: 40, width: 103, height: 32 } },
  ],
  splits: [
    { id: "root", direction: "right", ratio: 0.5164319, rect: { x: 0, y: 0, width: 213, height: 72 } },
    { id: "right", direction: "down", ratio: 0.56, rect: { x: 110, y: 0, width: 103, height: 72 } },
  ],
};

const key = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...init }) as KeyboardEvent;

describe("key map", () => {
  test("herdr's keys without the prefix", () => {
    expect(boardKeyCommand(key({ key: "ArrowLeft" }))).toEqual({ kind: "select", direction: "left" });
    expect(boardKeyCommand(key({ key: "k", code: "KeyK" }))).toEqual({ kind: "select", direction: "up" });
    expect(boardKeyCommand(key({ key: "L", code: "KeyL", shiftKey: true }))).toEqual({ kind: "swap", direction: "right" });
    // ⌥ on a Mac rewrites `key`; the physical code still resolves.
    expect(boardKeyCommand(key({ key: "˙", code: "KeyH", altKey: true }))).toEqual({ kind: "resize", direction: "left" });
    expect(boardKeyCommand(key({ key: "v" }))).toEqual({ kind: "split", direction: "right" });
    expect(boardKeyCommand(key({ key: "-" }))).toEqual({ kind: "split", direction: "down" });
    expect(boardKeyCommand(key({ key: "F10", shiftKey: true }))).toEqual({ kind: "menu" });
    expect(boardKeyCommand(key({ key: "=", ctrlKey: true }))).toBeNull();
    expect(boardKeyCommand(key({ key: "0" }))).toBeNull();
  });
});

describe("bound keys", () => {
  let release: () => void = () => {};
  beforeEach(resetBoardTestDOM);
  afterEach(() => { release(); for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); setLayoutDraft(null); });

  function rig(reasons: Partial<Record<BoardLayoutKind, string>> = {}, current: TabLayout = layout) {
    const viewport = document.createElement("div");
    for (const pane of current.panes) {
      const tile = document.createElement("div");
      tile.className = "board-pane";
      tile.dataset.paneId = pane.paneId;
      viewport.append(tile);
    }
    const input = document.createElement("input");
    viewport.append(input);
    document.body.append(viewport);
    const calls: string[] = [];
    const drafts: Array<LayoutDraft | null> = [];
    const hints: string[] = [];
    let settle: () => void = () => {};
    const controller = {
      layoutReason: (kind: BoardLayoutKind) => reasons[kind] ?? "",
      commitSwap: async (id: string, direction: LayoutDirection) => { calls.push(`swap ${id} ${direction}`); },
      commitResize: (request: ResizePaneInput) => {
        calls.push(`resize ${request.pane_id} ${request.direction} ${request.amount}`);
        drafts.push(layoutDraft());
        return new Promise<void>((resolve) => { settle = resolve; });
      },
      pickSplit: (id: string, direction: SplitDirection) => calls.push(`split ${id} ${direction}`),
      toggleZoom: async (id: string, mode: string) => { calls.push(`zoom ${id} ${mode}`); },
      paneAction: (id: string, action: string) => calls.push(`${action} ${id}`),
      openPane: (id: string) => calls.push(`open ${id}`),
      openMenu: (id: string) => calls.push(`menu ${id}`),
    } as unknown as BoardCanvasController;
    let ended = 0;
    release = bindBoardKeyboard(viewport, { layout: () => current, controller,
      hint: (text) => hints.push(text), endPlacement: () => { ended += 1; } });
    const press = (init: Partial<KeyboardEvent>, target: Element = viewport) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const selected = () => viewport.querySelector<HTMLElement>("[data-board-selected]")?.dataset.paneId;
    return { viewport, input, calls, drafts, hints, press, selected, settle: () => settle(), ended: () => ended };
  }

  test("the first arrow shows the selection on the computer's focused pane, the next moves it", () => {
    const r = rig();
    expect(r.viewport.tabIndex).toBe(0);
    expect(r.press({ key: "ArrowDown" })).toBeTrue();
    expect(r.selected()).toBe("b");
    r.press({ key: "ArrowDown" });
    expect(r.selected()).toBe("c");
    r.press({ key: "h", code: "KeyH" });
    expect(r.selected()).toBe("a");
    r.press({ key: "ArrowLeft" });
    expect(r.selected()).toBe("a");
  });

  test("shift swaps, ⌥ resizes as herdr's resize mode with a pending draft, the rest reach the controller", async () => {
    const r = rig();
    // No selection yet: the key acts on the computer's focused pane (b), which has nothing to its right.
    r.press({ key: "ArrowRight", shiftKey: true });
    expect(r.calls).toEqual([]);
    expect(r.hints).toEqual([t("pm.swapNoNeighbor")]);
    r.press({ key: "ArrowLeft", shiftKey: true });
    expect(r.calls).toEqual(["swap b left"]);

    r.press({ key: "ArrowRight", altKey: true });
    expect(r.calls.at(-1)).toBe("resize b right 0.05");
    expect(r.drafts.at(-1)).toMatchObject({ tabId: "w1:t1", splitId: "root", pending: true });
    expect(r.drafts.at(-1)!.ratio).toBeCloseTo(0.5664319, 9);
    r.settle();
    await Promise.resolve(); await Promise.resolve();
    expect(layoutDraft()).toBeNull();

    for (const [init, call] of [[{ key: "v" }, "split b right"], [{ key: "-" }, "split b down"], [{ key: "z" }, "zoom b on"],
      [{ key: "x" }, "close b"], [{ key: "F2" }, "rename b"], [{ key: "Enter" }, "open b"], [{ key: "ContextMenu" }, "menu b"]] as const) {
      r.press(init);
      expect(r.calls.at(-1)).toBe(call);
    }
  });

  test("refusals say why instead of acting", () => {
    const r = rig({ swap: "offline", resize: "busy", split: "offline", zoom: "offline" });
    r.press({ key: "ArrowDown" });
    r.press({ key: "ArrowUp", shiftKey: true });
    r.press({ key: "ArrowUp", altKey: true });
    r.press({ key: "v" });
    r.press({ key: "z" });
    expect(r.calls).toEqual([]);
    expect(r.hints).toEqual(["offline", "busy", "offline", "offline"]);

    const edge = rig();
    edge.press({ key: "ArrowLeft" });
    edge.press({ key: "ArrowLeft" });
    edge.press({ key: "ArrowUp", altKey: true });
    expect(edge.hints).toEqual([t("boardCanvas.keyNoDivider")]);
  });

  test("a focused tile is the selection, its buttons keep Enter, and overlay controls keep their keys", () => {
    const r = rig();
    const tileC = r.viewport.querySelector<HTMLElement>('[data-pane-id="c"]')!;
    const open = document.createElement("button");
    tileC.append(open);
    // Enter on the tile's own button stays native: nothing is prevented, no other pane opens.
    expect(r.press({ key: "Enter" }, open)).toBeFalse();
    expect(r.calls).toEqual([]);
    // Other keys act on the focused tile, not on the computer's focused pane.
    r.press({ key: "x" }, open);
    expect(r.calls).toEqual(["close c"]);
    const slider = document.createElement("span");
    slider.setAttribute("role", "slider");
    r.viewport.append(slider);
    expect(r.press({ key: "ArrowRight" }, slider)).toBeFalse();
    const banner = document.createElement("button");
    r.viewport.append(banner);
    expect(r.press({ key: "Enter" }, banner)).toBeFalse();
    expect(r.calls).toEqual(["close c"]);
  });

  test("a key resize clears only its own draft", async () => {
    const r = rig();
    r.press({ key: "ArrowRight", altKey: true });
    const other = { tabId: "w1:t2", splitId: "x", ratio: 0.4, pending: false };
    setLayoutDraft(other);
    r.settle();
    await Promise.resolve(); await Promise.resolve();
    expect(layoutDraft()).toEqual(other);
  });

  test("escape clears the selection and placement; typing in a field is never taken", () => {
    const r = rig();
    r.press({ key: "ArrowDown" });
    expect(r.press({ key: "Escape" })).toBeTrue();
    expect(r.selected()).toBeUndefined();
    expect(r.ended()).toBe(1);
    expect(r.press({ key: "v" }, r.input)).toBeFalse();
    expect(r.calls).toEqual([]);
  });
});
