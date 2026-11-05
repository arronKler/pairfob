import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * What the create sheet moves, pinned where the stylesheet says it: blocks that
 * fold without cutting a focus ring or leaving room behind, a choice that is
 * acknowledged over the press duration, and the full list travelling as a page.
 */
const css = compileScss(new URL("./create-sheet.scss", import.meta.url)).css.replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");
const px = (body: string, property: string) => Number(body.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`))?.[1]);

describe("create sheet motion", () => {
  test("a fold reaches a focus ring past its rows and gives that room back, open or shut", () => {
    // The app's ring: a 2px outline 2px off the control.
    const ring = 4;
    expect(px(declared(".create-fold-in"), "padding-block")).toBe(ring);
    expect(px(declared(".fold.create-fold"), "margin-block")).toBe(-ring);
    expect(px(declared(".create-fold > .fold-body"), "padding-inline")).toBe(ring);
    expect(px(declared(".create-fold > .fold-body"), "margin-inline")).toBe(-ring);
    // Shut, the block is no room at all, and the margin travels with the height.
    expect(declared(".fold.create-fold.is-shut")).toMatch(/margin-block:\s*0;/);
    expect(declared(".fold.create-fold")).toMatch(/transition:\s*grid-template-rows var\(--dur-3\) var\(--ease\),\s*opacity var\(--dur-2\) var\(--ease\),\s*margin var\(--dur-3\) var\(--ease\)/);
    // Its rows keep the margins they had in the form's own column.
    expect(declared(".create-fold-in")).toMatch(/display:\s*flex;\s*flex-direction:\s*column/);
  });

  test("a choice is acknowledged over the press duration on every chip, tile, row and star", () => {
    for (const selector of [".create-chip", ".create-kind", ".create-dir", ".kind-row", ".kind-star"]) {
      const transition = declared(selector).match(/transition:\s*([^;]+);/)?.[1] ?? "";
      expect(transition).not.toBe("");
      expect(transition.split(",").every(part => /var\(--dur-1\) var\(--ease\)$/.test(part.trim()))).toBeTrue();
    }
    expect(declared(".kind-star > svg")).toMatch(/fill-opacity:\s*0;\s*transition:\s*fill-opacity var\(--dur-1\) var\(--ease\)/);
    expect(declared(".kind-star.is-on > svg")).toMatch(/fill-opacity:\s*1/);
  });

  test("the full list comes in as a pushed page and the form comes back as a popped one, with no travel under reduced motion", () => {
    expect(declared(".create-sheet-body.is-picking")).toMatch(/animation:\s*sheet-page-push var\(--dur-3\) var\(--ease\)/);
    expect(declared(".create-sheet-body.is-back")).toMatch(/animation:\s*sheet-page-pop var\(--dur-3\) var\(--ease\)/);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)![1];
    expect(reduced).toMatch(/\.create-sheet-body\.is-picking,\s*\.create-sheet-body\.is-back\s*\{[^}]*animation:\s*none/);
  });

  test("the pinned footer still clears the scroller's padding when the form is one of the sheet's swapped views", () => {
    expect(css).toMatch(/\.sheet-body:has\(> \.create-sheet-body > \.create-footer, > \.create-swap > \.create-sheet-body > \.create-footer\)\s*\{[^}]*padding-bottom:\s*0/);
  });
});
