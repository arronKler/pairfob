import { describe, expect, test } from "bun:test";
import { compileScss } from "../../test-support/compiled-style";
import { parseAnsi, spanCss, spanInk } from "./ansi";
import { contrast, legibleInk, MIN_TEXT_CONTRAST, TERM_BACKGROUND, TERM_INK, UNREADABLE_CONTRAST } from "./ansi-contrast";

const css = compileScss(new URL("../style.scss", import.meta.url)).css;

describe("contrast", () => {
  test("is the WCAG ratio, either way round", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("rgb(119, 119, 119)", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#6b8cae", "#6b8cae")).toBe(1);
  });

  test("a colour it cannot read counts as no contrast and is never rewritten", () => {
    expect(contrast("currentColor", "#000000")).toBe(1);
    expect(legibleInk("currentColor", "#000000")).toBe("currentColor");
    expect(legibleInk("#000000", "var(--term-bg)")).toBe("#000000");
  });
});

describe("legibleInk", () => {
  test("ink at or over the floor is the ink that was sent", () => {
    for (const [ink, ground] of [[TERM_INK, TERM_BACKGROUND], ["#c45a38", TERM_BACKGROUND], ["#000000", "#6b8cae"]]) {
      expect(contrast(ink, ground)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(legibleInk(ink, ground)).toBe(ink);
    }
  });

  test("ink under the floor is moved to it and no further than it needs", () => {
    for (const [ink, ground] of [["#000000", TERM_BACKGROUND], ["#6a6a6a", "#6b8cae"], ["#6b8cae", "#6b8cae"], ["#7ea58c", "#7ea58c"], ["rgb(40, 40, 40)", TERM_BACKGROUND]]) {
      const moved = legibleInk(ink, ground);
      expect(moved).not.toBe(ink);
      expect(contrast(moved, ground)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      // A tenth of the way at a time: it stops within a step of the floor.
      expect(contrast(moved, ground)).toBeLessThan(MIN_TEXT_CONTRAST * 1.35);
    }
  });

  test("it stays on its side of the background when that side has room", () => {
    // Black on the dark default background can only get lighter.
    expect(contrast(legibleInk("#000000", TERM_BACKGROUND), "#000000")).toBeGreaterThan(1);
    // Grey on a blue bar that is lighter than it: a dark label stays a dark label.
    const label = legibleInk("#6a6a6a", "#6b8cae");
    expect(contrast(label, "#ffffff")).toBeGreaterThan(contrast("#6a6a6a", "#ffffff"));
  });

  test("where its own side cannot reach the floor it takes the side that reads better", () => {
    // Near-white on white: lighter runs out at once, so it goes dark.
    const moved = legibleInk("#f0f0f0", "#ffffff");
    expect(contrast(moved, "#ffffff")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrast(moved, "#000000")).toBeLessThan(contrast("#f0f0f0", "#000000"));
  });

  test("with a lower bar for what counts as unreadable, text a person can read is left as drawn", () => {
    // White on the guided palette's blue and yellow bars: under the floor, and read without effort.
    for (const [ink, ground] of [["#f3ead7", "#6b8cae"], ["#f3ead7", "#c4923a"]]) {
      expect(contrast(ink, ground)).toBeLessThan(MIN_TEXT_CONTRAST);
      expect(contrast(ink, ground)).toBeGreaterThanOrEqual(UNREADABLE_CONTRAST);
      expect(legibleInk(ink, ground, MIN_TEXT_CONTRAST, UNREADABLE_CONTRAST)).toBe(ink);
      expect(legibleInk(ink, ground)).not.toBe(ink);
    }
    // What is unreadable still goes all the way to the floor, not to the lower bar.
    const black = legibleInk("#000000", TERM_BACKGROUND, MIN_TEXT_CONTRAST, UNREADABLE_CONTRAST);
    expect(contrast(black, TERM_BACKGROUND)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

describe("spanCss keeps terminal text readable", () => {
  const first = (raw: string) => spanCss(parseAnsi(raw)[0].spans[0].style);

  test("colours that read are passed through, and uncoloured text names no colour", () => {
    expect(first("plain")).toEqual({});
    expect(first("\x1b[31mred")).toEqual({ color: "#c45a38" });
    expect(first("\x1b[1;30;44m NORMAL ")).toEqual({ color: "#000000", backgroundColor: "#6b8cae", fontWeight: "700" });
  });

  test("black on the default background, and a colour on itself, are lifted", () => {
    const black = first("\x1b[30mblack");
    expect(black.color).not.toBe("#000000");
    expect(contrast(black.color!, TERM_BACKGROUND)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    const same = first("\x1b[34;44mblue on blue");
    expect(same.backgroundColor).toBe("#6b8cae");
    expect(contrast(same.color!, "#6b8cae")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  test("uncoloured text on a light bar is given a colour that reads", () => {
    const onWhite = first("\x1b[107m bar ");
    expect(onWhite.backgroundColor).toBe("#f3ead7");
    expect(contrast(onWhite.color!, "#f3ead7")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  test("the palette's own white on a coloured bar is left as it is", () => {
    expect(first("\x1b[44;97m ~/work ")).toEqual({ color: "#f3ead7", backgroundColor: "#6b8cae" });
    expect(first("\x1b[43;97m +2 ")).toEqual({ color: "#f3ead7", backgroundColor: "#c4923a" });
    // Its plain white on yellow is 1.8:1, and that is not read without effort: it becomes a dark label.
    const flipped = first("\x1b[43;37m +2 ");
    expect(contrast(flipped.color!, "#c4923a")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrast(flipped.color!, "#ffffff")).toBeGreaterThan(contrast("#d6d0c2", "#ffffff"));
  });

  test("dim text is held to half the floor, so it can stay dim", () => {
    expect(first("\x1b[2;38;2;60;60;60mfaint")).toEqual({ color: "rgb(60, 60, 60)", opacity: "0.7" });
    expect(first("\x1b[38;2;60;60;60mfaint").color).not.toBe("rgb(60, 60, 60)");
    // Dim black on the default background is not there at all, and is brought to half the floor.
    const gone = first("\x1b[2;30mgone");
    expect(contrast(gone.color!, TERM_BACKGROUND)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST / 2);
    expect(contrast(gone.color!, TERM_BACKGROUND)).toBeLessThan(MIN_TEXT_CONTRAST);
  });

  test("a separator or a frame keeps the colour it was given, whatever it stands on", () => {
    // The cap that closes a blue bar on a grey one: blue on grey is 1.6:1, and it is not text.
    const [cap, label] = parseAnsi("\x1b[34;100m\ue0b4\x1b[97m main ")[0].spans;
    expect(spanCss(cap.style, cap.text)).toEqual({ color: "#6b8cae", backgroundColor: "#6a6a6a" });
    expect(spanCss(label.style, label.text).color).toBe("#f3ead7");
    // The same colours on a word are moved.
    expect(spanCss(cap.style, "main").color).not.toBe("#6b8cae");
    // A frame drawn in black on the default background stays the frame its program drew.
    const [frame] = parseAnsi("\x1b[30m\u256d\u2500\u2500\u256e")[0].spans;
    expect(spanCss(frame.style, frame.text)).toEqual({ color: "#000000" });
    // Without the text nothing is known to be a shape, and the rule applies.
    expect(spanCss(frame.style).color).not.toBe("#000000");
  });

  test("a separator that shares its run with text is told its own colour", () => {
    const [run] = parseAnsi("\x1b[34;100m\ue0b0 main")[0].spans;
    const css = spanCss(run.style, run.text);
    expect(css.color).not.toBe("#6b8cae");
    expect(spanInk(run.style)).toBe("#6b8cae");
    expect(spanInk({})).toBeUndefined();
    expect(spanInk({ inverse: true, fg: "#c45a38" })).toBe("#141414");
    expect(spanInk({ inverse: true, bg: "#6b8cae" })).toBe("#6b8cae");
  });

  test("an inverse cell is judged as it is painted", () => {
    const inverse = first("\x1b[7mcursor");
    expect(inverse).toEqual({ color: "#141414", backgroundColor: "#e6e6e6" });
  });
});

test("the default colours are the ones the stylesheet paints", () => {
  expect(css).toContain(`--term-bg: ${TERM_BACKGROUND}`);
  expect(css).toContain(`--term-ink: ${TERM_INK}`);
});
