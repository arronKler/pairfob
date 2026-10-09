import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The rail's head is 280px at its narrowest. These rules are what keep the
 * computer's name and its status whole there; layout is checked in a browser,
 * the rules it rests on are pinned here.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
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
