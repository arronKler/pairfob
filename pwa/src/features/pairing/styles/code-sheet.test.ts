import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The feedback slot under the code field. The sheet is anchored to the floor
 * and the page's own card is centred in its column, so the line under the field
 * must not change height when an error appears or is cleared by typing: that
 * would move the field under the finger, or the field and the button apart
 * under the pointer.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("the code field's feedback line", () => {
  test("the hint and the error share a slot two lines tall, in the sheet and in the card", () => {
    const line = Number(rule(".pair-help").match(/line-height:\s*([\d.]+);/)?.[1]);
    expect(line).toBe(1.45);
    // Two of the line's own line boxes: a one-line hint leaves the second empty.
    const reserved = Number(rule(":is(.pair-code-sheet, .connect-card) .pair-help").match(/min-height:\s*([\d.]+)em;/)?.[1]);
    expect(reserved).toBeCloseTo(2 * line, 5);
  });

  test("one rule sizes the slot for both, at every width; the narrowest English phone gets a third line", () => {
    expect(rule(".pair-help")).toMatch(/min-height:\s*20px/);
    expect(css.match(/\.pair-help\s*\{[^}]*min-height/g)).toHaveLength(3);
    const at = css.indexOf(":is(.pair-code-sheet, .connect-card) .pair-help {");
    // Outside every media block: the card is the same under a mouse at 800 and at 1440.
    expect(css.lastIndexOf("@media", at)).toBeLessThan(css.lastIndexOf("\n}\n", at));
    // The longest English messages run to three lines beside the counter at 320px.
    expect(css).toMatch(/@media \(max-width: 359\.98px\) \{\s*:lang\(en\) :is\(\.pair-code-sheet, \.connect-card\) \.pair-help \{\s*min-height:\s*4\.35em;/);
  });

  test("the message is balanced over its lines, in the sheet and in the card, so none ends in a stray character", () => {
    const feedback = rule(":is(.pair-code-sheet, .connect-card) #pair-feedback");
    expect(feedback).toMatch(/text-wrap:\s*balance/);
    // Chinese lines end at a pause, never inside a word; a run too long for the line still breaks.
    expect(feedback).toMatch(/word-break:\s*keep-all/);
    expect(feedback).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).not.toMatch(/#pair-feedback\s*\{[^}]*text-wrap:\s*pretty/);
  });
});

describe("the code field's counter", () => {
  test("it is green at fourteen and takes the message's error colour past it", () => {
    expect(rule(".field-count.ok")).toMatch(/color:\s*var\(--ok\)/);
    expect(rule(".field-count.over")).toMatch(/color:\s*var\(--error\)/);
    expect(rule(".pair-help.is-error")).toMatch(/color:\s*var\(--error\)/);
  });
});

describe("the code sheet's paste button", () => {
  test("it is a 44px target in Chinese too, with its words kept against the field's edge", () => {
    const paste = rule(".pair-paste");
    expect(paste).toMatch(/min-width:\s*44px/);
    expect(paste).toMatch(/min-height:\s*44px/);
    expect(paste).toMatch(/text-align:\s*right/);
  });

  test("the install link's target grows around its words to 44px", () => {
    // An inline link is as tall as its line (about 23px); the box around it adds 11px above and below.
    expect(rule(".connect-install::before")).toMatch(/inset:\s*-11px -6px/);
  });
});
