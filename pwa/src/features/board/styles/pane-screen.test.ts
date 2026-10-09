import { expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

const canvas = compile(fileURLToPath(new URL("./board-canvas.scss", import.meta.url)), { style: "expanded" }).css;

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return canvas.match(new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

/**
 * A terminal's first column is the prompt's `>` and a list's marks, and the
 * pane's ring is drawn over the pane's edge. The screen keeps clear of it by
 * the same screen pixels at every zoom, inside a pane box that does not change.
 */
test("the pane screen keeps a fixed on-screen margin clear of the pane's ring, at every zoom", () => {
  const buffer = rule(".board-pane-buffer");
  // The margin is counter-scaled like the ring it clears, and wider than the widest ring (2px).
  expect(buffer).toMatch(/--board-preview-pad:\s*calc\(4 \* var\(--board-control-scale, 1\)\)/);
  expect(rule(".board-pane.sel::after")).toMatch(/inset 0 0 0 calc\(2px \* var\(--board-control-scale, 1\)\)/);
  // Moved in by it on the left, and narrower by it on both sides: the fit by width times what is left of the width.
  expect(buffer).toMatch(/transform:\s*translate\(calc\(var\(--board-preview-pad\) \* 1px\), /);
  expect(buffer).toContain("var(--board-preview-fit-width, 1) * max(0.5, 1 - 2 * var(--board-preview-pad) / var(--board-preview-width, 100000))");
  expect(buffer).toMatch(/transform-origin:\s*0 0/);
  // The pane and its screen keep their boxes: no padding, no inset.
  expect(rule(".board-pane")).toMatch(/padding:\s*0/);
  expect(rule(".board-pane-screen")).toMatch(/inset:\s*0/);
});

/**
 * The title bar lies over the top of the pane and keeps its size on screen
 * while the stage scales: less than a row zoomed in, two rows on a phone. The
 * screen's first row is the agent's header or the top of a log, so it starts
 * under the bar at every zoom, and the last row stands off the ring below it.
 */
test("the pane screen's first row starts under the title bar, at every zoom", () => {
  const buffer = rule(".board-pane-buffer");
  // The bar's height in stage pixels, as the camera writes it; a whole default bar before it has.
  expect(buffer).toMatch(/--board-preview-top:\s*var\(--board-title-clear, 24\)/);
  // Moved down by it, and shorter by it and by the ring's margin: the fit by height times what is left of the height.
  expect(buffer).toMatch(/transform:\s*translate\([^,]+, calc\(var\(--board-preview-top\) \* 1px\)\)/);
  expect(buffer).toContain("var(--board-preview-fit-height, 1) * max(0.5, 1 - (var(--board-preview-top) + var(--board-preview-pad)) / var(--board-preview-height, 100000))");
  // One scale for both axes, the smaller of the two: the glyphs keep their aspect.
  expect(buffer).toMatch(/scale\(min\(var\(--board-preview-fit-width, 1\) \*[^;]*, var\(--board-preview-fit-height, 1\) \*[^;]*\)\);/);
  // The bar itself is as it was: over the pane's top, as tall as the camera says.
  expect(rule(".board-pane-title")).toMatch(/top:\s*0/);
  expect(rule(".board-pane-title")).toMatch(/height:\s*var\(--board-title-h, 24px\)/);
});
