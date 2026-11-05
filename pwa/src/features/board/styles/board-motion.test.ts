import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

const sheet = (name: string) => compileScss(new URL(name, import.meta.url)).css.replace(/\/\*[\s\S]*?\*\//g, "");
const canvas = sheet("./board-canvas.scss");
const overlays = sheet("./board-overlays.scss");
const declared = (css: string, selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].split(",").map((part) => part.trim()).includes(selector)).map((match) => match[2]).join("\n");
const list = (body: string, property: string) => (body.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1] ?? "").split(",").map((part) => part.trim().replace(/\s+/g, " "));

/**
 * The board's layout moves, pinned where the stylesheet says them. A tile's
 * box is inline and the same on every repaint, so these run only when the
 * layout itself changed.
 */
describe("board layout motion", () => {
  const BOX = ["left", "top", "width", "height", "min-width", "min-height"];

  test("a tile's box travels over the panel duration, with the minimums that are written with it", () => {
    const transition = list(declared(canvas, ".board-pane"), "transition");
    expect(transition.slice(0, BOX.length)).toEqual(BOX.map((property) => `${property} var(--dur-3) var(--ease)`));
    // The press and the dim it already had.
    expect(transition).toContain("transform var(--dur-1) var(--ease)");
    expect(transition).toContain("opacity var(--dur-2) var(--ease)");
  });

  test("the tiles that take a leaver's room wait out its fade, on the box and on nothing else", () => {
    expect(declared(canvas, ".board-pane.is-leaving")).toMatch(/opacity:\s*0;\s*transition:\s*opacity var\(--dur-1\) var\(--ease\)/);
    const properties = list(declared(canvas, ".board-pane"), "transition").map((part) => part.split(" ")[0]);
    const delays = list(declared(canvas, ".board-pane.is-after-exit"), "transition-delay");
    expect(delays).toHaveLength(properties.length);
    expect(properties.filter((_property, index) => delays[index] === "var(--dur-1)")).toEqual(BOX);
    expect(delays.filter((delay) => delay !== "var(--dur-1)").every((delay) => delay === "0s")).toBeTrue();
  });

  test("a new tile fades in after the others have begun to move, and a dragged divider eases nothing", () => {
    expect(declared(canvas, ".board-pane.is-entering")).toMatch(/animation:\s*board-pane-in var\(--dur-2\) var\(--ease\) var\(--dur-1\) backwards/);
    expect(canvas).toMatch(/@keyframes board-pane-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*\}\s*\}/);
    expect(declared(canvas, ".board-stage.is-dragging > .board-pane")).toMatch(/transition:\s*none/);
  });

  test("a held tile is at the finger and never eases along the way; put down, it settles back above its neighbours", () => {
    const held = list(declared(overlays, ".board-pane[data-board-lift]"), "transition").map((part) => part.split(" ")[0]);
    expect(held).toEqual(["scale", "box-shadow"]);
    const base = list(declared(canvas, ".board-pane"), "transition");
    expect(base).toContain("translate var(--dur-3) var(--ease-spring)");
    expect(base).toContain("scale var(--dur-2) var(--ease)");
    expect(base).toContain("box-shadow var(--dur-2) var(--ease)");
    expect(declared(overlays, ".board-pane[data-board-settle]")).toMatch(/z-index:\s*6/);
  });

  test("under reduced motion nothing waits for a leaver", () => {
    const reduced = canvas.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)![1];
    expect(reduced).toMatch(/\.board-pane\.is-after-exit\s*\{[^}]*transition-delay:\s*0s/);
    expect(reduced).toMatch(/\.board-pane\.is-entering\s*\{[^}]*animation-delay:\s*0s/);
  });
});
