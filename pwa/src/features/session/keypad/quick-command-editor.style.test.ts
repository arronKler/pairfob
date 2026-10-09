import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The command editor's multi-line field. It is four lines tall and scrolls
 * inside, so it offers no corner grip to drag: a mouse would show one, and the
 * sheet it sits in is sized to its content.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("the command editor's content field", () => {
  test("keeps its height: no resize grip", () => {
    const rule = css.match(/(?:^|\})\s*\.quick-sheet-field textarea\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/min-height:\s*128px/);
    expect(rule).toMatch(/resize:\s*none/);
    expect(css).not.toMatch(/\.quick-sheet[^{]*\{[^}]*resize:\s*(vertical|both)/);
  });
});
