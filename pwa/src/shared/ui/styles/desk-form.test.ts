import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * Below 900px a dialog is a bottom sheet by width alone, so every rule that
 * makes or dresses the sheet has to step aside for the desk form: the card a
 * mouse or the keyboard gets beside the list must be the wide window's card.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule inside every `@media (max-width: 899.98px)` block, as `[selector, body]`. */
function sheetTierRules(): [string, string][] {
  const rules: [string, string][] = [];
  const header = "@media (max-width: 899.98px) {";
  for (let at = css.indexOf(header); at >= 0; at = css.indexOf(header, at + 1)) {
    let depth = 1;
    let end = at + header.length;
    while (depth > 0 && end < css.length) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    for (const match of css.slice(at + header.length, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push([match[1].trim().replace(/\s+/g, " "), match[2]]);
    }
  }
  return rules;
}

/** A selector list's members; the commas inside `:where(:not(a, b))` are not separators. */
function members(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < list.length; at++) {
    if (list[at] === "(") depth++;
    else if (list[at] === ")") depth--;
    else if (list[at] === "," && depth === 0) { out.push(list.slice(from, at).trim()); from = at + 1; }
  }
  out.push(list.slice(from).trim());
  return out;
}

describe("the sheet tier leaves the desk form alone", () => {
  const rules = sheetTierRules();
  const find = (selector: string) => rules.find(([name]) => members(name).includes(selector))?.[1] ?? "";

  test("the tier's rules were found", () => {
    expect(rules.length).toBeGreaterThan(20);
    expect(find("dialog.modal:where(:not(.popover, .desk-form))")).toMatch(/margin:\s*auto auto 0/);
  });

  test("every rule that names a dialog excludes the desk form, or is not about the sheet", () => {
    // Not the sheet frame: the drag states only a bound gesture sets, the grab
    // handle the card does not draw, the help card that is centred at every
    // width, and search and jump, whose desk panel is written against
    // `.desk-form` right after its sheet rules.
    const exempt = /^dialog\.modal > form\.is-sheet-(dragging|closing)$|\.sheet-grab$|^dialog\.modal\.help\b|^dialog\.modal\.command-palette\b/;
    const named = rules.flatMap(([name]) => members(name)).filter(selector => /\bdialog\.modal\b/.test(selector));
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter(selector => !exempt.test(selector) && !selector.includes(".desk-form"))).toEqual([]);
  });

  test("the card has no grab handle and its fields keep the wide window's size", () => {
    expect(find(".desk-form .sheet-grab")).toMatch(/display:\s*none/);
    for (const control of ["input", "select", "textarea"]) {
      expect(find(`.operation-field:where(:not(.desk-form *)) ${control}`)).toMatch(/font-size:\s*16px/);
    }
    expect(rules.some(([name]) => /^\.operation-field (input|select|textarea)$/.test(name))).toBeFalse();
  });

  test("keyboard lifts and sheet heights belong to the sheet only", () => {
    expect(find("dialog.modal.pair-code-sheet:where(:not(.desk-form))")).toMatch(/margin-bottom:\s*var\(--kb, 0px\)/);
    expect(find("dialog.modal.pane-menu-sheet:where(:not(.popover, .desk-form))")).toMatch(/margin-bottom:\s*var\(--kb, 0px\)/);
    expect(find("dialog.modal.operation-modal:not(.sheet):where(:not(.desk-form)) > form")).toMatch(/max-height:\s*min\(34rem/);
    expect(find("dialog.modal.sheet.is-expandable:where(:not(.popover, .desk-form)) > form")).toMatch(/max-height:\s*min\(64dvh/);
  });

  test("the page behind recedes only on the class the sheet gesture sets", () => {
    // sheet-drag.ts adds `sheet-open` for a sheet and never for a card, so the
    // rule needs no knowledge of the dialog and the phone's selector is as it was.
    expect(find("body.sheet-open #app")).toMatch(/transform:\s*scale/);
  });
});
