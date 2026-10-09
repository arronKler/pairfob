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
