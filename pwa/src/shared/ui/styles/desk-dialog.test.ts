import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * One anatomy for every dialog a mouse or the keyboard opens beside the list:
 * title top left, close top right, actions in a footer at the bottom right,
 * a light scrim. All of it hangs off `.desk-form`, so the sheet keeps its bar.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** A selector list's members; a comma inside `:is(…)` is not a separator. */
function members(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { out.push(current); current = ""; } else current += char;
  }
  return [...out, current].map(part => part.trim().replace(/\s+/g, " "));
}

/** Bodies of every rule whose selector list has `selector` as a member, in source order. */
function rules(selector: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (members(match[1]).includes(selector)) out.push(match[2]);
  }
  return out;
}
const rule = (selector: string) => rules(selector).join("\n");

/** The same, for rules written for a mouse: inside `@media (hover: hover) and (pointer: fine)`. */
function fine(selector: string): string {
  const out: string[] = [];
  for (const block of css.matchAll(/@media \(hover: hover\) and \(pointer: fine\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
    for (const match of block[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (members(match[1]).includes(selector)) out.push(match[2]);
    }
  }
  return out.join("\n");
}

describe("desk form anatomy", () => {
  test("the scrim is light and the page behind stays sharp, for the card at any width it is drawn", () => {
    for (const selector of ["dialog.modal.desk-form::backdrop"]) {
      expect(rule(selector)).toMatch(/background:\s*rgba\(4, 6, 10, 0\.38\)/);
      expect(rule(selector)).toMatch(/backdrop-filter:\s*none/);
    }
    // From 900px the centred card is every dialog's shape, a finger's included.
    expect(css).toMatch(/@media \(min-width: 900px\) \{\s*dialog\.modal::backdrop \{[^}]*backdrop-filter:\s*none/);
    // The sheet's own scrim is the first, unscoped rule and is untouched.
    expect(rules("dialog.modal::backdrop")[0]).toMatch(/rgba\(4, 6, 10, 0\.66\)[\s\S]*blur\(4px\)/);
  });

  test("the close control sits in the corner and the title leaves it room", () => {
    expect(rule(".desk-close")).toMatch(/position:\s*absolute/);
    expect(rule("dialog.modal.desk-form:has(> form > .desk-close) > form > .modal-title")).toMatch(/padding-right:\s*34px/);
  });

  test("one footer: at the bottom right, Cancel quiet before the filled action, the same size in every dialog", () => {
    expect(rule(".desk-actions")).toMatch(/justify-content:\s*flex-end/);
    expect(rule(".desk-actions")).toMatch(/margin-top:\s*18px/);
    // Whatever class a dialog's own markup gives the button, the geometry is the one mixin's.
    const sized = [".desk-action", ".desk-cancel", "dialog.modal.desk-form .confirm-actions .btn",
      "dialog.modal:is(.desk-form, .popover-panel) .create-footer > .create-submit",
      "dialog.modal:is(.desk-form, .popover-panel) .pane-confirm-actions .btn"];
    for (const selector of sized) {
      const body = rule(selector);
      expect(body, selector).toMatch(/min-width:\s*5\.5rem/);
      expect(body, selector).toMatch(/min-height:\s*44px/);
      expect(body, selector).toMatch(/padding:\s*0 16px/);
      expect(body, selector).toMatch(/border-radius:\s*10px/);
      // A mouse gets the 36px row; the keyboard on a tablet keeps the finger's.
      expect(fine(selector), selector).toMatch(/min-height:\s*36px/);
    }
    expect(rule(".desk-cancel")).toMatch(/background:\s*transparent/);
    expect(rule(".desk-cancel")).toMatch(/color:\s*var\(--muted\)/);
    expect(rule(".desk-action.is-primary")).toMatch(/background:\s*var\(--accent\)/);
    // Nothing to submit yet: the button keeps its place and its shape.
    expect(rule(".desk-action.is-primary:disabled")).toMatch(/opacity:\s*1/);
    expect(rule("dialog.modal.desk-form .confirm-actions")).toMatch(/justify-content:\s*flex-end/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .create-footer")).toMatch(/justify-content:\s*flex-end/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .pane-confirm-actions")).toMatch(/justify-content:\s*flex-end/);
  });

  test("one head: a card with a scrolling body has the same title block, ruled off only once it has scrolled", () => {
    const head = rule(":where(:is(.desk-form, .popover-panel)) .sheet-head");
    expect(head).toMatch(/padding:\s*18px 52px 12px 18px/);
    expect(head).toMatch(/border-bottom-color:\s*transparent/);
    expect(rule(":where(:is(.desk-form, .popover-panel)) .sheet-head:has(+ .sheet-body[data-above])")).toMatch(/border-bottom-color:\s*var\(--line\)/);
    expect(rule(":where(.desk-form) .sheet-body")).toMatch(/padding:\s*2px 18px 18px/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) :is(.sheet-body, .sheet-foot) .create-footer")).toMatch(/border-top-color:\s*transparent/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .sheet-body[data-below] .create-footer")).toMatch(/border-top-color:\s*var\(--line\)/);
    // The help card takes the family's width and padding.
    expect(rule("dialog.modal.help.desk-form")).toMatch(/width:\s*min\(23rem, 100vw - 32px\)/);
    expect(rule("dialog.modal.help.desk-form")).toMatch(/padding:\s*18px/);
  });

  test("one footer place: under the scrolling body, so no scrollbar passes beside the actions or moves them", () => {
    const $desk = "dialog.modal:is(.desk-form, .popover-panel)";
    // Written after the scroller it needs neither the pin nor the margins that crossed the scroller's padding.
    expect(rule(`${$desk} .sheet-foot .create-footer`)).toMatch(/position:\s*static/);
    expect(rule(`${$desk} .sheet-foot .create-footer`)).toMatch(/margin:\s*0/);
    // Its inset is the card's own, the same whether or not the body scrolls; the panel under its button has the panel's.
    expect(rule(`${$desk} .create-footer`)).toMatch(/padding:\s*12px var\(--desk-pad, 18px\) var\(--desk-pad, 18px\)/);
    expect(rule(".popover-panel.pane-menu-sheet .sheet-foot")).toMatch(/--desk-pad:\s*14px/);
    // Ruled off only while more of the form waits beneath it, as when it was pinned.
    expect(rule(`${$desk} .sheet-body[data-below] + .sheet-foot .create-footer`)).toMatch(/border-top-color:\s*var\(--line\)/);
    // The body keeps the gap above the footer; a dialog with no footer draws no slot.
    expect(rule(`${$desk} .sheet-body:has(+ .sheet-foot:not(:empty))`)).toMatch(/padding-bottom:\s*14px/);
    expect(rule(".sheet-foot:empty")).toMatch(/display:\s*none/);
    expect(rule(".sheet-foot")).toMatch(/flex:\s*none/);
  });

  test("a page pushed inside a desk dialog has the way back and its title at the left", () => {
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .sheet-head.has-back .modal-title")).toMatch(/text-align:\s*left/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .sheet-head.has-back .modal-title")).toMatch(/font-size:\s*var\(--text-title\)/);
    expect(rule("dialog.modal:is(.desk-form, .popover-panel) .sheet-head.has-back .sheet-back-label")).toMatch(/display:\s*none/);
    // The sheet keeps its centred title and the named way back.
    expect(rule(".pane-menu-sheet .sheet-head.has-back .modal-title")).toMatch(/text-align:\s*center/);
  });

  test("none of it reaches a dialog that is not the desk form", () => {
    // Classes the sheet draws too; `.desk-actions`, `.desk-action` and `.desk-cancel` exist in the desk form's markup only.
    const shared = ["sheet-head", "sheet-body", "sheet-back", "confirm-actions", "create-footer", "create-submit", "create-hint",
      "pane-confirm-actions", "pane-head-close", "help-copy", "quick-sheet-body", "quick-sheet-hint", "quick-sheet-field-head"];
    const desk = /justify-content:\s*flex-end|border-(top|bottom)-color:\s*transparent|min-width:\s*5\.5rem|padding:\s*18px 52px|margin-inline:\s*0/;
    const scoped = /\.desk-form|\.popover-panel|\.popover-menu|\.popover /;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!desk.test(match[2])) continue;
      for (const selector of members(match[1])) {
        const last = selector.split(/\s+/).at(-1) ?? "";
        if (shared.some(name => new RegExp(`\\.${name}(?![\\w-])`).test(last))) expect(selector).toMatch(scoped);
      }
    }
  });
});
