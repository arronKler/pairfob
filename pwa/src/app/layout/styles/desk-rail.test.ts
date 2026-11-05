import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * The rail's head is 280px at its narrowest. These rules are what keep the
 * computer's name and its status whole there; layout is checked in a browser,
 * the rules it rests on are pinned here.
 */
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector list is exactly `selector`, outside or inside a query. */
function rule(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  if (at < 0) return "";
  return css.slice(at + selector.length + 2, css.indexOf("}", at));
}

const FINE = "@media (hover: hover) and (pointer: fine)";

describe("rail head", () => {
  test("the status is one row of whole parts: what does not fit wraps out of sight", () => {
    const line = rule(".rail-head .host-title-line.is-brief");
    expect(line).toMatch(/display:\s*flex/);
    expect(line).toMatch(/flex-wrap:\s*wrap/);
    expect(line).toMatch(/height:\s*1\.4em/);
    // The clip is the base title line's own.
    expect(rule(".host-title-line")).toMatch(/overflow:\s*hidden/);
    const part = rule(".rail-head .host-title-fact");
    expect(part).toMatch(/flex:\s*none/);
    // The joining dot's spaces are part of the text, and a part never breaks inside.
    expect(part).toMatch(/white-space:\s*pre\b/);
    expect(part).toMatch(/max-width:\s*100%/);
  });

  test("the head holds two controls beside the title; the Herdr-session switch is a row under it", () => {
    expect(css).not.toContain(".rail-head .herd-session-switch");
    const row = rule(".rail > .herd-session-switch");
    expect(row).toMatch(/min-height:\s*44px/);
    expect(row).toMatch(/display:\s*flex/);
    expect(rule(".rail > .herd-session-switch .herd-session-name")).toMatch(/text-overflow:\s*ellipsis/);
    // A mouse gets the compact row; a finger keeps the 44px one.
    const fine = css.indexOf(FINE, css.indexOf(".rail-nav-dot"));
    expect(rule(".rail > .herd-session-switch", fine)).toMatch(/min-height:\s*30px/);
  });
});

describe("rail rows and headings under a mouse", () => {
  const fine = css.slice(css.indexOf(FINE, css.indexOf(".rail-nav-dot")));
  /** Every rule of the mouse block whose selector list has `selector`, joined. */
  const within = (selector: string) => [...fine.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(",").map(part => part.trim().replace(/\s+/g, " ")).includes(selector)).map(match => match[2]).join("\n");

  test("a row's actions fade in over the row's own ground, and pointing at a row moves none of its text", () => {
    const cluster = within(".rail .card-actions");
    expect(cluster).toMatch(/transition:\s*opacity var\(--dur-1\) var\(--ease\)/);
    expect(cluster).toMatch(/background-color:\s*var\(--row-ground\)/);
    // Until shown they take no press: a finger on a touch-screen laptop still opens the row.
    expect(cluster).toMatch(/pointer-events:\s*none/);
    // The fade the text runs out under is no part of a button.
    const lead = within(".rail .card-actions::before");
    expect(lead).toMatch(/linear-gradient\(to right, transparent, var\(--row-ground\)\)/);
    expect(lead).toMatch(/pointer-events:\s*none/);
    // The text keeps its width: nothing pads the row for the cluster, and the time and dot fade instead of leaving.
    expect(within(".rail .card:hover .card-main")).not.toMatch(/padding/);
    expect(within(".rail .card.is-unread:hover .card-main")).toBe("");
    expect(within(".rail .card:hover .card-side")).toMatch(/opacity:\s*0/);
    expect(within(".rail .card:hover .card-side")).not.toMatch(/display/);
    expect(within(".rail .card-side")).toMatch(/transition:\s*opacity var\(--dur-1\) var\(--ease\)/);
  });

  test("a heading's tools take no room, shown or not, and no press until shown", () => {
    const tool = within(".rail .group-head .group-tool");
    expect(tool).toMatch(/width:\s*30px/);
    expect(tool).toMatch(/margin-left:\s*-30px/);
    expect(tool).toMatch(/opacity:\s*0/);
    expect(tool).toMatch(/pointer-events:\s*none/);
    expect(tool).toMatch(/transition:\s*opacity var\(--dur-1\) var\(--ease\)/);
    // Two tools: the first gives back the width of both.
    expect(within(".rail .group-head .group-tool:has(+ .group-tool)")).toMatch(/margin-left:\s*-60px/);
    expect(within(".rail .group-head .group-tool + .group-tool")).toMatch(/margin-left:\s*0/);
    const shown = within(".rail .group-head:hover .group-tool");
    expect(shown).toMatch(/opacity:\s*1/);
    expect(shown).toMatch(/pointer-events:\s*auto/);
    expect(shown).not.toMatch(/width/);
  });
});
