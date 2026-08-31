import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./viewport.ts", import.meta.url)).text();
const { visualViewportFrame } = await import("./viewport.ts");

describe("visualViewportFrame", () => {
  test("keyboard overlay with the visual viewport unpanned", () => {
    expect(visualViewportFrame(844, { height: 480, offsetTop: 0 })).toEqual({
      top: 0,
      height: 480,
      kb: 364,
    });
  });

  test("iOS pans the visual viewport toward the focused field", () => {
    expect(visualViewportFrame(844, { height: 480, offsetTop: 200 })).toEqual({
      top: 200,
      height: 480,
      kb: 164,
    });
  });

  test("resizes-content already matched the visual viewport", () => {
    expect(visualViewportFrame(480, { height: 480, offsetTop: 0 })).toEqual({
      top: 0,
      height: 480,
      kb: 0,
    });
  });

  test("a missing visualViewport fills the layout viewport", () => {
    expect(visualViewportFrame(844, null)).toEqual({ top: 0, height: 844, kb: 0 });
  });

  test("a zero-height visualViewport does not collapse the shell", () => {
    expect(visualViewportFrame(844, { height: 0, offsetTop: 0 }).height).toBe(844);
  });
});

describe("visual viewport listeners", () => {
  test("a finger pan only reapplies the frame, it does not pin the buffer", () => {
    expect(source).toContain('addEventListener("scroll", applyVisualViewport)');
    expect(source).toContain('addEventListener("resize", resized)');
    expect(source).not.toMatch(/visualViewport\?\.addEventListener\("scroll", resized\)/);
    expect(source).toContain('addEventListener("focusin"');
    expect(source).toContain('addEventListener("focusout"');
  });
});
