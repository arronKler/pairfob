import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The row menu as a sheet. Whether its actions fit a phone is measured in a
 * browser; what that rests on is pinned here: the heights the sheet is built
 * from, and that none of it reaches the popover or another sheet.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] }));
const rules = (selector: string) => blocks.filter(block => block.selector.split(",").map(part => part.trim()).includes(selector))
  .map(block => block.body).join("\n");
/** The first length of a declaration, in pixels; a bare 0 is a length too. */
const px = (body: string, property: string) => Number(body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(-?[\\d.]+)(?:px)?[;\\s]`))?.[1] ?? Number.NaN);

const SHEET = ".object-menu-sheet:not(.popover)";

describe("object menu sheet", () => {
  test("a heading is a caption set into the rule, not a block above the rows", () => {
    const title = rules(`${SHEET} .menu-section-title`);
    expect(title).toMatch(/display:\s*flex/);
    expect(title).toMatch(/border:\s*0/);
    expect(title).toMatch(/padding:\s*0/);
    expect(px(title, "line-height")).toBe(14);
    const rule = rules(`${SHEET} .menu-section-title::after`);
    expect(rule).toMatch(/flex:\s*1 1 auto/);
    expect(px(rule, "height")).toBe(1);
    expect(rule).toMatch(/background:\s*var\(--line\)/);
  });

  test("three headings and six facts cost no more than the untitled menu's facts did", () => {
    const title = rules(`${SHEET} .menu-section-title`);
    const [top, , bottom] = title.match(/margin:\s*(-?[\d.]+)px (-?[\d.]+)(?:px)? (-?[\d.]+)px/)!.slice(1).map(Number);
    const heading = top + px(title, "line-height") + bottom;
    // A fact row: the value's line at the body size (0.84rem of 16px) and the row's padding.
    const lineHeight = Number(rules(`${SHEET} .sheet-fact > *`).match(/line-height:\s*([\d.]+)/)![1]);
    const pad = Number(rules(`${SHEET} .sheet-fact`).match(/padding:\s*([\d.]+)px 0/)![1]);
    const row = 0.84 * 16 * lineHeight + 2 * pad;
    const facts = rules(`${SHEET} .sheet-facts`);
    const closed = rules(`${SHEET} .sheet-facts:has(+ .menu-section-title)`);
    const block = px(facts, "margin") + 6 * row + px(closed, "padding-bottom") + px(closed, "margin-bottom");
    // What the same six facts took before the headings: 7px rows at 1.45, a 6/8 margin, 2/10 padding and the rule.
    const before = 6 + 2 + 6 * (0.84 * 16 * 1.45 + 14) + 10 + 1 + 8;
    expect(3 * heading + block).toBeLessThanOrEqual(before);
    expect(closed).toMatch(/border-bottom:\s*0/);
  });

  test("nothing of it reaches the anchored menu or any other sheet", () => {
    const own = blocks.filter(block => block.selector.includes("object-menu-sheet"));
    expect(own.length).toBeGreaterThan(0);
    for (const block of own) {
      for (const part of block.selector.split(",")) expect(part.trim().startsWith(SHEET)).toBe(true);
    }
    // The shared heading every other sheet draws is as it was.
    expect(rules(".menu-section-title")).toMatch(/margin:\s*14px 0 0/);
    expect(rules(".sheet-fact")).toMatch(/padding:\s*7px 0/);
    // And it is still the first rule a lookup by its last class finds (`style.test.ts` reads it that way).
    expect(css.match(/[^{}]*\.sheet-fact-val\s*\{/)![0].trim()).toBe(".sheet-fact-val {");
  });
});
