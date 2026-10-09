import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * A short explanatory paragraph (a note, a footnote, a lede, an item's second
 * line) sits in a column a few words wide and tends to end in one word on a
 * line of its own, or in Chinese a character and its full stop. Each of them
 * breaks into even lines instead. Where they break is read in a browser at
 * every width and in both languages; that every such paragraph asks for it is
 * pinned here, across the sheets that own them.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");

describe("short explanatory paragraphs", () => {
  test("each breaks into even lines", () => {
    for (const selector of [
      // Pairing and the computer picker.
      ".connect-lede", ".connect-phone-note", ".trust", ".lede", ".computer-add .switch-meta",
      // The list's empty states, in the rail and on the phone page, and the main column's line.
      ".herd-empty-title", ".herd-empty-sub", ".herd-empty-note", ".herd-empty-panel-title", ".main .desk-empty .empty-sub",
      // Reconnecting and cannot reach.
      ".conn-path-note", ".conn-step-body small", ".boot-text", ".boot-recovery p",
      // Settings: footnotes, notes, an item's second line where it is a sentence, the update help and the rail's update card.
      ".set-foot", ".set-item-note", ".notification-item .set-item-sub", ".set-radio .set-item-sub",
      ".daemon-update-help .set-note", ".daemon-update-help summary", ".rail .daemon-update .set-row > .set-note",
    ]) expect(declared(selector), selector).toMatch(/text-wrap:\s*balance/);
  });

  test("a line of facts joined by dots is left to wrap plainly: evened out it would start a line with the dot", () => {
    expect(declared(".set-item-sub")).not.toMatch(/text-wrap/);
  });

  test("the trust line is one centred sentence with its lock in the first line", () => {
    const trust = declared(".trust");
    expect(trust).toMatch(/text-align:\s*center/);
    // Not a row of two boxes: the sentence's box would then be as wide as the column and its lines left-set beside the lock.
    expect(trust).not.toMatch(/display:\s*flex/);
    expect(declared(".trust svg")).toMatch(/margin-right:\s*6px/);
  });
});

describe("the update help's disclosure", () => {
  test("the question is a 44px row that ends in the settings family's turning chevron", () => {
    const summary = declared(".daemon-update-help summary");
    expect(summary).toMatch(/min-height:\s*44px/);
    expect(summary).toMatch(/justify-content:\s*space-between/);
    expect(declared(".set-disclosure")).toMatch(/transition:\s*transform/);
    expect(declared(".daemon-update-help[open] summary .set-disclosure")).toMatch(/rotate\(180deg\)/);
  });

  test("closed, its card has the same room above and below the row; the answer brings the floor", () => {
    expect(declared(".set-card.daemon-update-help")).toMatch(/padding:\s*4px 16px;/);
    expect(declared(".set-card.daemon-update-help[open]")).toMatch(/padding-bottom:\s*14px/);
  });
});
