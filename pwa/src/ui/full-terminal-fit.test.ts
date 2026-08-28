import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
happy.document.body.innerHTML = "<main></main>";

const {
  FULL_TERM_FONT_MIN,
  FULL_TERM_LINE_HEIGHT,
  FULL_TERM_TARGET_COLS,
  clearScreenScale,
  displayGrid,
  hostInnerSize,
  integerizeDomRows,
  lineHeightForIntegerCells,
  paintedFontSize,
  pickFontSize,
  pitchLineHeight,
  probePanCanvas,
  ptyCols,
  sizePanCanvas,
  snapCellLineHeight,
  visualCells,
  xtermCssCellHeight,
} = await import("./full-terminal-fit.ts");

const cellAt = (fontSize: number) => fontSize * 0.6;

describe("complete-terminal fit keeps a web-terminal column count", () => {
  test("a 390px phone stops shrinking at a readable minimum even if 80 columns do not fit", () => {
    const font = pickFontSize({
      hostWidth: 390,
      cellWidthAt: cellAt,
      preferred: 12,
      locked: false,
    });
    expect(font).toBe(FULL_TERM_FONT_MIN);
    expect(font).toBeGreaterThanOrEqual(11);
  });

  test("a wide desk keeps the preferred type scale", () => {
    expect(
      pickFontSize({
        hostWidth: 1200,
        cellWidthAt: cellAt,
        preferred: 13,
        locked: false,
      }),
    ).toBe(13);
  });

  test("a pinch-locked size is not auto-shrunk", () => {
    expect(
      pickFontSize({
        hostWidth: 390,
        cellWidthAt: cellAt,
        preferred: 16,
        locked: true,
      }),
    ).toBe(16);
  });

  test("pan keeps 80 columns on a phone and uses the extra room on a desk", () => {
    expect(ptyCols(40, "pan")).toBe(FULL_TERM_TARGET_COLS);
    expect(ptyCols(100, "pan")).toBe(100);
    expect(ptyCols(40, "fit")).toBe(40);
    expect(ptyCols(0, "pan")).toBe(FULL_TERM_TARGET_COLS);
  });

  test("the pan canvas is the PTY width, not the phone host", () => {
    const canvas = document.createElement("div");
    probePanCanvas(canvas, 382);
    expect(canvas.style.width).toBe("382px");
    sizePanCanvas(canvas, true, 80, 9.63, 382);
    expect(canvas.style.width).toBe("770px");
    sizePanCanvas(canvas, false, 80, 9, 382);
    expect(canvas.style.width).toBe("");
  });

  test("row pitch is at least 1.5 so CJK fallback glyphs fit the cell", () => {
    expect(FULL_TERM_LINE_HEIGHT).toBe(1.5);
  });
});

describe("complete-terminal cells sit on integer CSS pixels", () => {
  test("xterm's 8px / 4/3 / 3x dpr cell is fractional", () => {
    expect(xtermCssCellHeight(8, 4 / 3, 3, 24)).not.toBe(Math.round(xtermCssCellHeight(8, 4 / 3, 3, 24)));
  });

  test("the snapped line height yields an integer cell", () => {
    const rows = 24;
    const dpr = 3;
    const lh = lineHeightForIntegerCells({ fontSize: 8, minLineHeight: 4 / 3, dpr, rows });
    const cell = xtermCssCellHeight(8, lh, dpr, rows);
    expect(cell).toBe(Math.round(cell));
    expect(cell).toBeGreaterThanOrEqual(8);
  });

  test("pitch never goes below the CJK minimum", () => {
    const lh = pitchLineHeight(12, 12, 2, 30);
    expect(lh).toBeGreaterThanOrEqual(FULL_TERM_LINE_HEIGHT);
    const cell = xtermCssCellHeight(12, lh, 2, 30);
    expect(cell).toBe(Math.round(cell));
  });

  test("a taller CJK glyph raises the cell", () => {
    const tight = pitchLineHeight(12, 12, 2, 24);
    const roomy = pitchLineHeight(12, 20, 2, 24);
    expect(roomy).toBeGreaterThan(tight);
    expect(xtermCssCellHeight(12, roomy, 2, 24)).toBeGreaterThanOrEqual(21);
  });

  test("a measured fractional cell bumps lineHeight to the next pixel", () => {
    expect(snapCellLineHeight(1.5, 12)).toBe(1.5);
    expect(snapCellLineHeight(1.5, 12.4)).toBeCloseTo(1.5 * (13 / 12.4), 8);
  });
});

describe("complete-terminal display grid follows the remote frame", () => {
  test("without a remote frame the phone host wins", () => {
    expect(displayGrid({ cols: 80, rows: 40 }, null)).toEqual({ cols: 80, rows: 40 });
  });

  test("a split-pane frame does not keep empty phone rows", () => {
    expect(displayGrid({ cols: 80, rows: 40 }, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
  });

  test("a larger remote PTY is still clipped to the fitted host", () => {
    expect(displayGrid({ cols: 80, rows: 40 }, { cols: 160, rows: 80 })).toEqual({ cols: 80, rows: 40 });
  });
});

describe("complete-terminal host metrics", () => {
  test("inner size subtracts padding from clientWidth", () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 390 });
    Object.defineProperty(host, "clientHeight", { value: 500 });
    host.style.paddingTop = "4px";
    host.style.paddingBottom = "4px";
    host.style.paddingLeft = "6px";
    host.style.paddingRight = "6px";
    document.body.append(host);
    expect(hostInnerSize(host)).toEqual({ width: 378, height: 492 });
    host.remove();
  });

  test("visual cells read the screen box, not the padded host", () => {
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    document.body.append(host);
    screen.getBoundingClientRect = () => ({ width: 384, height: 496, top: 0, left: 0, bottom: 496, right: 384, x: 0, y: 0, toJSON: () => ({}) });
    expect(visualCells(host, 80, 31)).toEqual({ width: 5, height: 16 });
    host.remove();
  });

  test("clearScreenScale drops a leftover CSS scale", () => {
    const host = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    host.append(screen);
    screen.style.transformOrigin = "0 0";
    screen.style.transform = "scale(1.04)";
    clearScreenScale(host);
    expect(screen.style.transform).toBe("");
    expect(screen.style.transformOrigin).toBe("");
  });

  test("painted font size follows the browser when it inflates xterm's request", () => {
    const host = document.createElement("div");
    const rows = document.createElement("div");
    rows.className = "xterm-rows";
    host.append(rows);
    const original = window.getComputedStyle.bind(window);
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: (el: Element) => (el === rows ? { fontSize: "16px" } : original(el)),
    });
    expect(paintedFontSize(host, 11)).toBe(16);
    expect(paintedFontSize(host, 18)).toBe(18);
    Object.defineProperty(window, "getComputedStyle", { configurable: true, value: original });
  });

  test("integerizeDomRows pins each row to a whole CSS pixel", () => {
    const host = document.createElement("div");
    const rows = document.createElement("div");
    rows.className = "xterm-rows";
    const a = document.createElement("div");
    const b = document.createElement("div");
    a.style.height = "12.4px";
    b.style.height = "12.4px";
    rows.append(a, b);
    host.append(rows);
    integerizeDomRows(host, 12.4);
    expect(a.style.height).toBe("12px");
    expect(a.style.lineHeight).toBe("12px");
    expect(b.style.height).toBe("12px");
    expect(a.style.overflow).toBe("hidden");
  });
});
