import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * The close question at the foot of the session menu. Its boxes are measured in
 * a browser; the rules that keep a long path and a scaled-up label inside the
 * card are pinned here.
 */
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim().replace(/\s+/g, " ")).includes(selector)).map(match => match[2]).join("\n");

describe("the close question", () => {
  test("the block takes the card's width, not its content's", () => {
    // Without a fixed column minimum, the session's path (a nowrap line) can
    // size the column and push the buttons past the card, where they are cut.
    expect(rules(".pane-confirm")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rules(".pane-confirm-subject")).toMatch(/min-width:\s*0/);
    expect(rules(".pane-confirm-subject small")).toMatch(/text-overflow:\s*ellipsis/);
  });

  test("its two answers share the row until neither can keep its word, then stack", () => {
    expect(rules(".pane-confirm-actions"))
      .toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(7rem, 100%\), 1fr\)\)/);
    expect(rules(".pane-confirm-actions .btn")).toMatch(/min-width:\s*0/);
  });
});
