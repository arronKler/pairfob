import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { roomBesideRail, SelectHint, selectHintEnd } from "./select-hint";

/**
 * The selection hint floats over the buffer, so it has to stay off the lines
 * being selected: a row picked near the top of the screen used to sit under it.
 */
const STAGE = { top: 53, bottom: 725 };

describe("which end of the buffer the hint takes", () => {
  test("the top, unless the selection is under it", () => {
    expect(selectHintEnd("top", { top: 225, bottom: 243 }, STAGE)).toBe("top");
    expect(selectHintEnd("top", { top: 99, bottom: 117 }, STAGE)).toBe("bottom");
  });

  test("it comes back when the selection moves to the bottom", () => {
    expect(selectHintEnd("bottom", { top: 300, bottom: 320 }, STAGE)).toBe("bottom");
    expect(selectHintEnd("bottom", { top: 690, bottom: 708 }, STAGE)).toBe("top");
  });

  test("a selection under both ends, or none at all, leaves it where it is", () => {
    expect(selectHintEnd("top", { top: 60, bottom: 720 }, STAGE)).toBe("top");
    expect(selectHintEnd("bottom", { top: 60, bottom: 720 }, STAGE)).toBe("bottom");
    expect(selectHintEnd("bottom", null, STAGE)).toBe("bottom");
  });
});

describe("room beside a scroll rail lying under the buffer", () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, height });

  test("a landscape phone: the rail's row is under the buffer, and the room is what lies before it", () => {
    // 844x390: stage 53..271, buffer 53..227, four buttons centred in the row below.
    expect(roomBesideRail(box(0, 53, 844, 218), box(0, 53, 844, 174), box(325, 227, 194, 44))).toEqual({ start: 0, end: 519 });
    // Beside the list the framed buffer stands in from the stage's side.
    expect(roomBesideRail(box(280, 53, 744, 249), box(297, 66, 710, 191), box(555, 257, 194, 44))).toEqual({ start: 17, end: 469 });
  });

  test("a rail standing at the buffer's side, or hidden for a mouse, leaves the hint over the buffer", () => {
    expect(roomBesideRail(box(0, 53, 390, 656), box(0, 53, 390, 656), box(342, 505, 44, 194))).toBeNull();
    expect(roomBesideRail(box(280, 53, 744, 259), box(297, 66, 710, 245), box(0, 0, 0, 0))).toBeNull();
  });
});

describe("the hint in the buffer", () => {
  let getSelection: typeof document.getSelection;
  let selected: { top: number; bottom: number } | null = null;
  const hint = () => appRoot().querySelector<HTMLElement>(".select-hint")!;
  const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const changed = () => act(() => { document.dispatchEvent(new happy.Event("selectionchange") as unknown as Event); });

  beforeEach(async () => {
    await resetBoardTestDOM();
    setLang("zh");
    selected = null;
    getSelection = document.getSelection;
    document.getSelection = (() => {
      const line = appRoot().querySelector(".term-line");
      if (!selected || !line) return null;
      const edges = selected;
      return {
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({ commonAncestorContainer: line, getBoundingClientRect: () => edges }),
      };
    }) as unknown as typeof document.getSelection;
    act(() => {
      renderReact(<div className="term-stage"><div className="term"><div className="term-line">row</div></div><SelectHint /></div>);
    });
    appRoot().querySelector<HTMLElement>(".term-stage")!.getBoundingClientRect = () => STAGE as DOMRect;
  });

  afterEach(() => {
    act(() => { unmountReact(); });
    document.getSelection = getSelection;
  });

  test("opens at the top and says how to leave", () => {
    expect(hint().className).toBe("select-hint");
    expect(hint().getAttribute("role")).toBe("status");
    expect(hint().querySelector(".select-done")?.textContent).toBe("完成");
  });

  test("takes the bottom on the frame it opens over a row picked near the top", async () => {
    unmountReact();
    selected = { top: 99, bottom: 117 };
    act(() => {
      renderReact(<div className="term-stage"><div className="term"><div className="term-line">row</div></div><SelectHint /></div>);
    });
    appRoot().querySelector<HTMLElement>(".term-stage")!.getBoundingClientRect = () => STAGE as DOMRect;
    await act(frame);
    expect(hint().className).toBe("select-hint is-below");
  });

  test("follows the selection as its handles are dragged", () => {
    selected = { top: 99, bottom: 117 };
    changed();
    expect(hint().className).toBe("select-hint is-below");
    selected = { top: 99, bottom: 400 };
    changed();
    expect(hint().className).toBe("select-hint is-below");
    selected = { top: 650, bottom: 700 };
    changed();
    expect(hint().className).toBe("select-hint");
    // A selection elsewhere on the page is not this buffer's.
    document.getSelection = (() => ({
      rangeCount: 1, isCollapsed: false,
      getRangeAt: () => ({ commonAncestorContainer: document.body, getBoundingClientRect: () => ({ top: 60, bottom: 80 }) }),
    })) as unknown as typeof document.getSelection;
    changed();
    expect(hint().className).toBe("select-hint");
  });

  test("takes the rail's row when the screen turns to landscape, and gives it back", () => {
    const stage = appRoot().querySelector<HTMLElement>(".term-stage")!;
    const term = stage.querySelector<HTMLElement>(".term")!;
    const rail = document.createElement("div");
    rail.className = "full-terminal-scroll";
    stage.append(rail);
    const lay = (stageBox: object, termBox: object, railBox: object): void => {
      stage.getBoundingClientRect = () => stageBox as DOMRect;
      term.getBoundingClientRect = () => termBox as DOMRect;
      rail.getBoundingClientRect = () => railBox as DOMRect;
      act(() => { window.dispatchEvent(new happy.Event("resize") as unknown as Event); });
    };
    selected = { top: 99, bottom: 117 };
    changed();
    expect(hint().className).toBe("select-hint is-below");
    lay({ left: 0, right: 844, top: 53, bottom: 271, height: 218 }, { left: 0, right: 844, top: 53, bottom: 227, height: 174 },
      { left: 325, right: 519, top: 227, bottom: 271, height: 44 });
    expect(hint().className).toBe("select-hint is-beside-rail");
    expect(hint().style.getPropertyValue("--select-hint-start")).toBe("0px");
    expect(hint().style.getPropertyValue("--select-hint-end")).toBe("519px");
    // Back to portrait: the rail stands at the side again, and the hint is where the selection left it.
    lay({ left: 0, right: 390, top: 53, bottom: 709, height: 656 }, { left: 0, right: 390, top: 53, bottom: 709, height: 656 },
      { left: 342, right: 386, top: 505, bottom: 699, height: 194 });
    expect(hint().className).toBe("select-hint is-below");
    expect(hint().style.getPropertyValue("--select-hint-end")).toBe("");
  });
});
