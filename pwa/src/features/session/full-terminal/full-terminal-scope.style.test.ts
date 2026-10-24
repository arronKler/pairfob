import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The complete terminal draws on a near-black plate whatever the page wears, so
 * its chrome needs a dark ink there. That ink has to be scoped to the terminal:
 * `--term-ink` and `--term-bg` also serve the compose field and Markdown code
 * blocks, which follow the page, and pinning them on `:root` puts light ink on a
 * white field.
 */

const sheet = (path: string): string => compile(fileURLToPath(new URL(path, import.meta.url)), { style: "expanded" }).css;
const css = sheet("../../../style.scss");
const terminal = sheet("./full-terminal.scss");

/** The declarations of the last rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const at = source.lastIndexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return source.slice(at, source.indexOf("}", at));
}

/** The `:root` block, which is what a page inherits before any scoping. */
function rootBlock(source: string): string {
  const at = source.indexOf(":root {");
  return source.slice(at, source.indexOf("\n}", at));
}

describe("the terminal's dark palette stays inside the terminal", () => {
  test("the page's own ink follows its palette, so a light document reads dark on paper", () => {
    // Both sides state the pair; neither pins the whole product to a dark value.
    expect(css).toContain("--term-ink: #dfe5ee;");
    expect(css).toContain("--term-ink: #1b222c;");
    expect(css).toContain("--term-bg: #ffffff;");
  });

  test("the terminal root overrides the ink and the field's ground for its own subtree", () => {
    const root = rule(terminal, ".full-terminal-root");
    expect(root).toContain("--term-ink: #dfe5ee;");
    // The compose field is cut into the plate, so it cannot keep the page's sink.
    expect(root).toContain("--sink:");
    // And the plate itself is one value, so its overlays and the screen agree.
    expect(root).toContain("--term-plate:");
  });

  test("the shared overrides are not removed from the theme", () => {
    const light = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
    expect(light).toContain("--term-ink: #1b222c");
    expect(rootBlock(css)).toContain("--term-ink: #dfe5ee");
  });
});
