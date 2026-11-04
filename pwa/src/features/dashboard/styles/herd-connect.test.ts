import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The text links on the reconnecting and cannot-reach pages are drawn as words
 * in a caption and pressed as buttons. Under a finger each takes an unseen box
 * up to 44px; the boxes are measured with real touches in a browser and the
 * numbers they rest on are pinned here.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const coarse = css.slice(css.indexOf("@media (any-pointer: coarse) {\n  .conn-path-actions .text-link"));
const block = coarse.slice(0, coarse.indexOf("\n}\n"));
const declared = (source: string, selector: string) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");
const px = (body: string, property: string) => Number(body.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`))?.[1]);
const inset = (body: string) => (body.match(/inset:\s*([^;]+);/g) ?? []).at(-1)!.match(/-?\d+/g)!.map(Number);

describe("the route with a long computer name", () => {
  test("the computer's stop gives way by ellipsis instead of pushing past the card", () => {
    expect(declared(css, ".conn-path")).toMatch(/display:\s*flex/);
    expect(declared(css, ".conn-node")).toMatch(/flex:\s*0 1 auto/);
    expect(declared(css, ".conn-node")).toMatch(/min-width:\s*70px/);
    const label = declared(css, ".conn-node b");
    expect(label).toMatch(/max-width:\s*100%/);
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("small links under a finger", () => {
  test("the links under the route reach 44px without being drawn any taller", () => {
    expect(px(declared(css, ".conn-path-actions .text-link"), "min-height")).toBe(36);
    const [vertical] = inset(declared(block, ".conn-path-actions .text-link::before"));
    expect(36 - 2 * vertical).toBeGreaterThanOrEqual(44);
    expect(declared(block, ".conn-path-actions .text-link")).toMatch(/position:\s*relative/);
  });

  test("the link under the retry button reaches 44px downwards and stops at the button above it", () => {
    expect(px(declared(css, ".conn-retry-add"), "min-height")).toBe(32);
    const [top, , bottom] = inset(declared(block, ".conn-retry-add::before"));
    expect(32 - top - bottom).toBeGreaterThanOrEqual(44);
    // The dock stacks the button and the note 4px apart; its floor keeps 10px under the note.
    const dock = declared(css, ".conn-retry-dock");
    expect(px(dock, "gap")).toBeGreaterThanOrEqual(-top);
    expect(Number(dock.match(/padding:\s*\d+px \d+px (\d+)px/)![1])).toBeGreaterThanOrEqual(-bottom);
  });

  test("only a finger gets the boxes, and only where the link is not already a 44px target", () => {
    expect(block.startsWith("@media (any-pointer: coarse)")).toBeTrue();
    expect(css.match(/\.conn-retry-add::before/g)).toHaveLength(block.match(/\.conn-retry-add::before/g)!.length);
    expect(px(declared(css, ".main-unreachable .conn-retry-add"), "min-height")).toBe(44);
    expect(declared(block, ".main-unreachable .conn-retry-add::before")).toMatch(/inset:\s*0 -4px/);
  });
});

/**
 * The route's moves hang on a state class changing on an element that stays,
 * so drawing the card again (it counts seconds) moves nothing.
 */
describe("the route's moves", () => {
  test("a link that comes through is drawn across from the device's side; one that is lost shows at once", () => {
    const line = declared(css, ".conn-link::before");
    expect(line).toMatch(/transform:\s*scaleX\(0\)/);
    expect(line).toMatch(/transform-origin:\s*0 50%/);
    expect(line).not.toMatch(/transition/);
    expect(declared(css, ".conn-link.is-ok::before")).toMatch(/transform:\s*none;\s*transition:\s*transform var\(--dur-4\) var\(--ease\)/);
    // The line is the through state's only paint: the link itself has no ground then.
    expect(declared(css, ".conn-link.is-ok")).toBe("");
  });

  test("a node going idle dims over the element duration, and its result is an element that can arrive", () => {
    expect(declared(css, ".conn-node")).toMatch(/transition:\s*opacity var\(--dur-2\) var\(--ease\)/);
    expect(declared(css, ".conn-node-badge")).toMatch(/position:\s*absolute/);
    expect(declared(css, ".conn-node.is-ok .conn-node-badge::before")).toMatch(/content:\s*"✓"/);
    expect(declared(css, ".conn-node.is-fail .conn-node-badge::before")).toMatch(/content:\s*"✕"/);
    expect(css).not.toMatch(/\.conn-node-icon::after/);
  });

  test("the retry button's mark has one box and its label one cell for both wordings", () => {
    const mark = declared(css, ".conn-retry-mark");
    expect([px(mark, "width"), px(mark, "height")]).toEqual([18, 18]);
    expect(declared(css, ".conn-retry-label")).toMatch(/display:\s*inline-grid/);
    expect(declared(css, ".conn-retry-label::after")).toMatch(/grid-area:\s*1\s*\/\s*1/);
    expect(declared(css, ".conn-retry-label::after")).toMatch(/content:\s*attr\(data-reserve\);\s*visibility:\s*hidden/);
  });
});
