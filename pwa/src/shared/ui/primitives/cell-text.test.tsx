import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compileScss } from "../../../../test-support/compiled-style";
import { cellText } from "./cell-text";

const html = (text: string) => renderToStaticMarkup(<span>{cellText(text)}</span>);

test("ordinary text is the string itself, with no element added", () => {
  expect(cellText("$ ls -la  ⏺ 中文 │")).toBe("$ ls -la  ⏺ 中文 │");
  expect(cellText("\u00a0")).toBe("\u00a0");
});

test("an icon gets a cell of its own and the text keeps every character", () => {
  expect(html(" \uf07b src")).toBe('<span> <span class="cell-icon" aria-hidden="true"><span class="cell-glyph">\uf07b</span></span> src</span>');
  expect(html("\u{f0219}")).toBe('<span><span class="cell-icon" aria-hidden="true"><span class="cell-glyph cell-glyph-mdi">\u{f0219}</span></span></span>');
});

test("a Powerline separator is a shape, and still in the text", () => {
  expect(html("main \ue0b0")).toBe('<span>main <span class="cell-shape cell-shape-b0" aria-hidden="true">\ue0b0</span></span>');
});

test("a separator can be given the colour of its bar when the run around it was recoloured", () => {
  expect(html("\ue0b0 main")).toBe('<span><span class="cell-shape cell-shape-b0" aria-hidden="true">\ue0b0</span> main</span>');
  expect(renderToStaticMarkup(<span>{cellText("\ue0b0 main", "#6b8cae")}</span>))
    .toBe('<span><span class="cell-shape cell-shape-b0" aria-hidden="true" style="color:#6b8cae">\ue0b0</span> main</span>');
  // An icon is text to read: it takes the run's colour.
  expect(renderToStaticMarkup(<span>{cellText("\uf07b", "#6b8cae")}</span>)).not.toContain("style=");
});

for (const entry of ["../../../style.scss", "../../../connected.scss"]) {
  test(`${entry.split("/").pop()} styles the cell and all sixteen shapes`, () => {
    const css = compileScss(new URL(entry, import.meta.url)).css;
    // The rule whose whole selector this is: `.term.wrapped .cell-shape` is another rule.
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\n)${selector.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    // One cell wide, and free to run into the next: that is the terminal's rule for an icon.
    expect(rule(".cell-icon")).toMatch(/display:\s*inline-block/);
    expect(rule(".cell-icon")).toMatch(/width:\s*1ch/);
    expect(rule(".cell-icon")).not.toMatch(/overflow/);
    // The glyph takes no line height of its own, or an icon face's ascent would nudge the row.
    expect(rule(".cell-glyph")).toMatch(/line-height:\s*0/);
    expect(rule(".cell-shape")).toMatch(/width:\s*1ch/);
    expect(rule(".cell-shape")).toMatch(/height:\s*1lh/);
    expect(rule(".cell-shape")).toMatch(/-webkit-text-fill-color:\s*transparent/);
    // Wrapped rows colour the text's own box, not the row, and the shape follows.
    const wrapped = css.match(/\.term\.wrapped \.cell-shape\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(wrapped).toMatch(/height:\s*auto/);
    expect(wrapped).toMatch(/line-height:\s*normal/);
    expect(wrapped).toMatch(/vertical-align:\s*baseline/);
    // A default-background cell in a row filled to its end is painted, in both grids, and not where rows wrap.
    expect(css).toMatch(/\.term:not\(\.wrapped\) \.term-line > \.cell-plain\s*\{\s*background-color:\s*var\(--term-bg\)/);
    expect(css).toMatch(/\.board-pane-line > \.cell-plain\s*\{\s*background-color:\s*var\(--term-bg\)/);
    for (let shape = 0xb0; shape <= 0xbf; shape++) {
      expect(css).toContain(`.cell-shape-${shape.toString(16)}::before`);
    }
  });
}
