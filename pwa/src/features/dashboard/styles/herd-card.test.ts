import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/** The actions behind a swiped row. Geometry is checked in a browser; the rules it rests on are pinned here. */
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim().replace(/\s+/g, " ")).includes(selector)).map(match => match[2]).join("\n");

describe("swipe actions", () => {
  test("the first trailing action fills what an over-pull uncovers, with its content where it rests", () => {
    const pin = rules(".card-action.is-pin");
    const width = Number(pin.match(/width:\s*(\d+)px/)![1]);
    const lead = Number(pin.match(/padding:\s*0 0 0 (\d+)px/)![1]);
    // The content box is the 72px every action has; the lead is what the pull can uncover (48px) and more.
    expect(rules(".card-action")).toMatch(/width:\s*72px/);
    expect(width - lead).toBe(72);
    expect(lead).toBeGreaterThanOrEqual(48);
    // The other action keeps its width, and the pair still ends the row.
    expect(rules(".card-action.is-more")).not.toMatch(/flex|width/);
    expect(rules(".card-actions")).toMatch(/justify-content:\s*flex-end/);
  });

  test("under a mouse the same buttons are a fixed cluster and none of them stretches", () => {
    const fine = css.slice(css.indexOf("@media (hover: hover) and (pointer: fine)", css.indexOf(".rail-nav-dot")));
    const cluster = fine.slice(fine.indexOf(".rail .card-action,"), fine.indexOf("}", fine.indexOf(".rail .card-action,")));
    expect(cluster).toMatch(/width:\s*28px/);
    expect(cluster).toMatch(/padding:\s*0/);
  });
});

describe("list touch targets", () => {
  test("a heading's count is finger-wide on touch and as wide as its words under a mouse", () => {
    const mark = rules(".group-mark");
    expect(mark).toMatch(/min-width:\s*44px/);
    expect(mark).toMatch(/min-height:\s*44px/);
    // Above the path line that wraps under the title on the phone.
    expect(mark).toMatch(/position:\s*relative/);
    const fine = css.slice(css.indexOf("@media (hover: hover) and (pointer: fine)", css.indexOf(".rail-nav-dot")));
    expect(fine).toMatch(/\.rail \.group-mark \{\s*min-width:\s*0;/);
  });

  test("the copy button beside a command is drawn 36px tall and reaches 44 within the row's padding", () => {
    expect(rules(".herd-empty-copy")).toMatch(/min-height:\s*36px/);
    expect(rules(".herd-empty-copy")).toMatch(/position:\s*relative/);
    const reach = Number(rules(".herd-empty-copy::after").match(/inset:\s*-(\d+)px 0/)![1]);
    expect(36 + 2 * reach).toBeGreaterThanOrEqual(44);
    const padding = Number(rules(".herd-empty-command").match(/padding:\s*(\d+)px/)![1]);
    expect(reach).toBeLessThanOrEqual(padding);
  });
});

describe("list motion", () => {
  test("a fold in the list clips only while it moves or is shut: at rest a row's focus ring passes its edge", () => {
    const rest = rules(".fold.herd-group-fold:not(.is-folding) > .fold-body");
    expect(rest).toMatch(/overflow:\s*visible/);
    expect(rules(".fold.herd-row:not(.is-entering):not(.is-leaving) > .fold-body")).toBe(rest);
    // The kit's own rule is the clip, and nothing here restates it.
    expect(rules(".fold > .fold-body")).toMatch(/overflow:\s*hidden/);
  });

  test("a closed session's row fades first and gives up its height after", () => {
    // The fold's two transitions, in the kit's order: height, then opacity.
    expect(rules(".fold")).toMatch(/transition:\s*grid-template-rows var\(--dur-3\) var\(--ease\), opacity var\(--dur-2\) var\(--ease\)/);
    expect(rules(".fold.herd-row.is-leaving")).toMatch(/transition-delay:\s*var\(--dur-2\), 0s/);
  });

  test("a new session's row takes the change sweep once it is open, and shows it only while it runs", () => {
    const sweep = rules(".herd-row.is-entering .card::after");
    expect(sweep).toMatch(/animation:\s*card-sweep var\(--dur-trace\) var\(--ease\)/);
    expect(sweep).toMatch(/animation-name:\s*card-sweep, card-sweep-shown/);
    expect(sweep).toMatch(/animation-delay:\s*var\(--dur-3\)/);
    expect(sweep).toMatch(/animation-fill-mode:\s*none/);
    expect(sweep).toMatch(/opacity:\s*0/);
  });

  test("a list that can no longer be confirmed dims over a moment, and comes back the same way", () => {
    expect(rules(".card")).toMatch(/transition:\s*opacity var\(--dur-3\) var\(--ease\)/);
    expect(rules(".card.unverifiable")).toMatch(/opacity:\s*0\.66/);
    expect(rules(".host-title .dot")).toMatch(/transition:\s*background-color var\(--dur-2\) var\(--ease\)/);
  });
});
