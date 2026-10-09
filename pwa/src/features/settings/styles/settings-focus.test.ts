import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The keyboard's ring in settings follows what each control is drawn as. Two
 * shapes need help: a pill drawn inside a taller target, and a row as wide as
 * the card that clips it. How they look is checked with Tab in a browser; the
 * rules they rest on are pinned here.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");
/** The body of the rule whose selector list holds `selector` as written (one with commas of its own inside `:is()`). */
const ruleWith = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].includes(selector)).map(match => match[2]).join("\n");

describe("settings focus rings", () => {
  test("a pill drawn inside a 44px target is ringed round the pill", () => {
    // The pill is the pseudo-element; the button's own box is the square target.
    expect(declared(".set-action::before")).toMatch(/border-radius:\s*9px/);
    expect(declared(".set-action:focus-visible")).toMatch(/outline:\s*none/);
    const ring = declared(".set-action:focus-visible::before");
    expect(ring).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(ring).toMatch(/outline-offset:\s*2px/);
  });

  test("the same holds for the chips in a page's top bar and in the rail's head", () => {
    for (const chip of [".topbar-create", ".rail-create"]) {
      expect(declared(`${chip}::after`)).toMatch(/border-radius/);
      expect(declared(`${chip}:focus-visible`)).toMatch(/outline:\s*none/);
      expect(declared(`${chip}:focus-visible::after`)).toMatch(/outline:\s*2px solid var\(--accent\)/);
    }
  });

  test("a row is ringed inside its card, which clips anything outside, and takes the card's corners at its ends", () => {
    expect(declared(".set-card")).toMatch(/overflow:\s*hidden/);
    expect(declared(".set-card")).toMatch(/border-radius:\s*var\(--r-lg\)/);
    expect(ruleWith(".set-card :is(button.set-item, .cp-main, summary):focus-visible")).toMatch(/outline-offset:\s*-2px/);
    const first = ruleWith(".set-card > :is(button, summary):first-child:focus-visible");
    const last = ruleWith(".set-card > :is(button, summary):last-child:focus-visible");
    // One pixel inside the card's own radius: the card's border lies between them.
    expect(first.match(/border-top-(?:left|right)-radius:\s*calc\(var\(--r-lg\) - 1px\)/g)).toHaveLength(2);
    expect(last.match(/border-bottom-(?:left|right)-radius:\s*calc\(var\(--r-lg\) - 1px\)/g)).toHaveLength(2);
    // A run of choices nested one level down ends at the card's corners too.
    expect(ruleWith(".set-card > :first-child > button.set-item:first-child:focus-visible")).toBe(first);
    expect(ruleWith(".set-card > :last-child > button.set-item:last-child:focus-visible")).toBe(last);
  });

  test("controls drawn at their own size keep the plain ring", () => {
    for (const selector of [".set-switch:focus-visible", ".set-seg .seg-item:focus-visible"]) expect(declared(selector)).toBe("");
  });
});
