import { afterEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { COMPOSE_MIN_PX } from "./compose-store";
import { COMPOSE_FRAME_PX, COMPOSE_LINE_PX, caretScrollTop, composeMaxPx, draftLineCount, fitComposeHeight, wholeLineWindow, type ComposeRoom } from "./compose-size";

const room = (patch: Partial<ComposeRoom>): ComposeRoom => ({
  viewport: 800,
  header: 56,
  dockChrome: 150,
  termRow: 18,
  line: COMPOSE_LINE_PX,
  frame: COMPOSE_FRAME_PX,
  ...patch,
});
const fourLines = COMPOSE_FRAME_PX + 4 * COMPOSE_LINE_PX;

describe("compose max height", () => {
  test("a tall screen caps the field at 40% of the visual viewport", () => {
    expect(composeMaxPx(room({ viewport: 800 }))).toBe(320);
  });

  test("keyboard up: six terminal rows stay visible under the header and dock", () => {
    // 480 − 56 − 150 − 6 × 18 = 166, below 40 % (192).
    expect(composeMaxPx(room({ viewport: 480 }))).toBe(166);
  });

  test("four lines stay available when the screen has room for them", () => {
    // 40 % would be 136 and six rows leave 84: four lines still fit above three rows.
    const max = composeMaxPx(room({ viewport: 340, dockChrome: 90 }));
    expect(max).toBe(Math.floor(fourLines));
  });

  test("never smaller than one line", () => {
    expect(composeMaxPx(room({ viewport: 200, dockChrome: 190 }))).toBe(COMPOSE_MIN_PX);
  });

  test("a phone on its side: whole lines out of what the terminal can spare, and no more", () => {
    // The complete terminal at 844x390 with the dense pad open: 390 − 53 − 111
    // of dock − 161 of host floor leaves 65px, which is two lines (63.6 → 64).
    const dense = { viewport: 390, header: 53, termRow: 21 };
    expect(composeMaxPx(room({ ...dense, dockChrome: 111, terminalFloor: 161 }))).toBe(64);
    // At 740x360 nothing is left over: the field keeps its one line and scrolls inside.
    expect(composeMaxPx(room({ ...dense, viewport: 360, dockChrome: 100, terminalFloor: 161 }))).toBe(COMPOSE_MIN_PX);
    // The pad collapsed gives the lines back (390 − 53 − 63 − 161 = 113: four lines).
    expect(composeMaxPx(room({ ...dense, dockChrome: 63, terminalFloor: 161 }))).toBe(Math.ceil(fourLines));
    // Never past the ordinary cap, however little the terminal asks for.
    expect(composeMaxPx(room({ ...dense, dockChrome: 63, terminalFloor: 0 })))
      .toBe(composeMaxPx(room({ ...dense, dockChrome: 63 })));
  });

  test("a cap that is not whole lines is cut back to the line below it", () => {
    // 75px to spare: two lines are 63.6, three would be 84.4.
    const max = composeMaxPx(room({ viewport: 360, header: 53, dockChrome: 100, termRow: 18, terminalFloor: 132 }));
    expect(max).toBe(Math.ceil(COMPOSE_FRAME_PX + 2 * COMPOSE_LINE_PX));
  });

  test("line count follows logical lines", () => {
    expect(draftLineCount("")).toBe(0);
    expect(draftLineCount("one")).toBe(1);
    expect(draftLineCount("a\nb\n")).toBe(3);
  });
});

describe("fitting the field to its draft", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--vv-height");
    for (const el of document.querySelectorAll("body > textarea")) el.remove();
  });

  /** A border-box textarea whose content (text and padding) is `content` px tall, with 1px borders. */
  async function field(content: number, viewport = 900): Promise<{ el: HTMLTextAreaElement; overflowWhenMeasured: () => string }> {
    await resetBoardTestDOM();
    document.documentElement.style.setProperty("--vv-height", `${viewport}px`);
    const el = document.createElement("textarea");
    document.body.append(el);
    let measuredWith = "";
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => { measuredWith = el.style.overflowY; return content; } },
      clientHeight: { configurable: true, get: () => 44 },
      offsetHeight: { configurable: true, get: () => 46 },
    });
    return { el, overflowWhenMeasured: () => measuredWith };
  }

  test("the height set is the border box: content plus the two borders", async () => {
    // Two lines under a mouse: 59px of text and padding. Set to 59, the field
    // showed 57 of them and scrolled inside itself.
    const { el } = await field(59);
    expect(fitComposeHeight(el)).toBeTrue();
    expect(el.style.height).toBe("61px");
  });

  test("a fractional line height is rounded up, not left to scroll by the remainder", async () => {
    // Three 20.8px lines and 20px of padding are 82.4px; the browser reports 82.
    const { el } = await field(82);
    el.style.lineHeight = "20.8px";
    el.style.paddingTop = "10px";
    el.style.paddingBottom = "10px";
    fitComposeHeight(el);
    expect(el.style.height).toBe("85px");
    // Two of them are 61.6px, reported as 62: already whole lines rounded up.
    const two = await field(62);
    two.el.style.lineHeight = "20.8px";
    two.el.style.paddingTop = "10px";
    two.el.style.paddingBottom = "10px";
    fitComposeHeight(two.el);
    expect(two.el.style.height).toBe("64px");
    // Whole sums gain nothing: two 19.5px lines and the padding are exactly 59.
    const whole = await field(59);
    whole.el.style.lineHeight = "19.5px";
    whole.el.style.paddingTop = "10px";
    whole.el.style.paddingBottom = "10px";
    fitComposeHeight(whole.el);
    expect(whole.el.style.height).toBe("61px");
  });

  test("one line stays at the field's resting height", async () => {
    const { el } = await field(41);
    fitComposeHeight(el);
    expect(el.style.height).toBe(`${COMPOSE_MIN_PX}px`);
  });

  test("a draft taller than the room stops at the cap, where scrolling inside is right", async () => {
    const { el } = await field(2000);
    fitComposeHeight(el);
    expect(el.style.height).toBe(el.style.maxHeight);
    expect(Number.parseFloat(el.style.height)).toBeLessThan(2000);
  });

  test("the draft is measured without a scrollbar, and the field gets its own back", async () => {
    const { el, overflowWhenMeasured } = await field(79);
    fitComposeHeight(el);
    expect(overflowWhenMeasured()).toBe("hidden");
    expect(el.style.overflowY).toBe("");
  });
});

describe("a field shortened under its draft keeps the caret's line in view", () => {
  // Six 21px lines over 10px of padding: 145px of content in a field cut to 104.
  const field = { paddingTop: 10, paddingBottom: 10, clientHeight: 104, scrollHeight: 145 };

  test("a caret on the last line scrolls the field to its end, the padding under the line included", () => {
    expect(caretScrollTop({ ...field, caretTop: 114, caretBottom: 135, scrollTop: 0 })).toBe(41);
  });

  test("a caret already showing moves nothing", () => {
    expect(caretScrollTop({ ...field, caretTop: 31, caretBottom: 52, scrollTop: 0 })).toBe(0);
    expect(caretScrollTop({ ...field, caretTop: 73, caretBottom: 94, scrollTop: 20 })).toBe(20);
  });

  test("a caret above the cut comes back with the padding over its line", () => {
    expect(caretScrollTop({ ...field, caretTop: 31, caretBottom: 52, scrollTop: 41 })).toBe(21);
    expect(caretScrollTop({ ...field, caretTop: 10, caretBottom: 31, scrollTop: 41 })).toBe(0);
  });

  test("a field too short for the line and both paddings shows the line's top", () => {
    expect(caretScrollTop({ paddingTop: 10, paddingBottom: 10, clientHeight: 30, scrollHeight: 145, caretTop: 73, caretBottom: 94, scrollTop: 0 })).toBe(63);
  });
});

describe("a field shorter than its draft stands on whole lines", () => {
  // Six 20.8px lines in 10px of padding either side: 145px of content (144.8).
  const draft = { line: COMPOSE_LINE_PX, paddingTop: 10, paddingBottom: 10, scrollHeight: 145 };
  const lineTop = (index: number) => 10 + index * COMPOSE_LINE_PX;
  /** The lines wholly inside what the window leaves uncovered, 1-based. */
  const shown = (clientHeight: number, stand: { scrollTop: number; top: number; bottom: number }): number[] => {
    const from = stand.scrollTop + stand.top;
    const to = stand.scrollTop + clientHeight - stand.bottom;
    return [0, 1, 2, 3, 4, 5].filter((index) => lineTop(index) >= from - 0.5 && lineTop(index + 1) <= to + 0.5).map((index) => index + 1);
  };
  /** Nothing of any other line is left uncovered. */
  const clean = (clientHeight: number, stand: { scrollTop: number; top: number; bottom: number }): boolean => {
    const from = stand.scrollTop + stand.top;
    const to = stand.scrollTop + clientHeight - stand.bottom;
    return [0, 1, 2, 3, 4, 5].every((index) => {
      const whole = lineTop(index) >= from - 0.5 && lineTop(index + 1) <= to + 0.5;
      const out = lineTop(index + 1) <= from + 0.5 || lineTop(index) >= to - 0.5;
      return whole || out;
    });
  };

  test("568x320 with the pad open: one line, and where it used to show half of line 5 above line 6 it shows line 6", () => {
    // The field is 46px (44 inside its border). Scrolled to its end by the caret rule it stood at 101.
    const stand = wholeLineWindow({ ...draft, clientHeight: 44, caretTop: lineTop(5), scrollTop: 101 });
    expect(stand.scrollTop).toBe(101);
    expect(shown(44, stand)).toEqual([6]);
    expect(clean(44, stand)).toBeTrue();
    // The last line cannot be scrolled up to the padding's edge: the strip over it is 13px, not 10.
    expect(stand.top).toBeCloseTo(13, 0);
  });

  test("844x390 with the pad open: two lines, the caret's and the one before", () => {
    const stand = wholeLineWindow({ ...draft, clientHeight: 62, caretTop: lineTop(5), scrollTop: 83 });
    expect(shown(62, stand)).toEqual([5, 6]);
    expect(clean(62, stand)).toBeTrue();
  });

  test("a scroll that stopped between two lines settles on the nearer one", () => {
    // Dragged to 49: nearer line 3 (41.6) than line 4 (62.4). The caret's line is kept in the window.
    const stand = wholeLineWindow({ ...draft, clientHeight: 62, caretTop: lineTop(3), scrollTop: 49 });
    expect(stand.scrollTop).toBe(42);
    expect(shown(62, stand)).toEqual([3, 4]);
    expect(clean(62, stand)).toBeTrue();
  });

  test("the caret's line is always one of them: above the window, and below it", () => {
    const above = wholeLineWindow({ ...draft, clientHeight: 44, caretTop: lineTop(1), scrollTop: 101 });
    expect(shown(44, above)).toEqual([2]);
    const below = wholeLineWindow({ ...draft, clientHeight: 62, caretTop: lineTop(4), scrollTop: 0 });
    expect(shown(62, below)).toEqual([4, 5]);
    expect(clean(62, below)).toBeTrue();
  });

  test("at the top of the draft the padding is the padding and nothing more is covered", () => {
    const stand = wholeLineWindow({ ...draft, clientHeight: 104, caretTop: lineTop(0), scrollTop: 0 });
    expect(stand).toEqual({ scrollTop: 0, top: 10, bottom: expect.closeTo(10.8, 1) });
    expect(shown(104, stand)).toEqual([1, 2, 3, 4]);
  });
});
