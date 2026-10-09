import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

const sheet = (name: string) => compile(fileURLToPath(new URL(name, import.meta.url)), { style: "expanded" }).css;
const canvas = sheet("./board-canvas.scss");
const chrome = sheet("./board-chrome.scss");
const menu = sheet("./pane-menu.scss");

/** The bodies of every `@media <query> { … }` block in a stylesheet, joined. */
function media(css: string, query: string): string {
  const header = `@media ${query}`;
  let out = "";
  for (let start = css.indexOf(header); start >= 0; start = css.indexOf(header, start + 1)) {
    const open = css.indexOf("{", start + header.length);
    if (css.slice(start + header.length, open).trim()) continue;
    let depth = 1;
    let index = open + 1;
    for (; index < css.length && depth; index++) depth += css[index] === "{" ? 1 : css[index] === "}" ? -1 : 0;
    out += css.slice(open + 1, index - 1);
  }
  return out;
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`))?.[1] ?? "";
}

const px = (body: string, property: string) => Number(body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(-?[\\d.]+)px`))?.[1]);

describe("board touch targets", () => {
  const coarse = media(canvas, "(any-pointer: coarse)");

  test("a finger's target for a pane's ⋯ is 44px square, inside what the pane clips", () => {
    const more = rule(canvas, ".board-pane > .board-pane-more");
    expect(rule(canvas, ".board-pane")).toMatch(/overflow:\s*hidden/);
    const [top, right, bottom, left] = rule(coarse, ".board-pane > .board-pane-more::after")
      .match(/inset:\s*(\S+) (\S+) (calc\([^;]+\)) (\S+);/)!.slice(1);
    // Nothing above or right of the button: the pane would clip it away.
    expect([top, right]).toEqual(["0", "0"]);
    // The bar is `--board-title-h` tall; the area hangs below it to 44px in all.
    expect(more).toMatch(/height:\s*var\(--board-title-h, 24px\)/);
    expect(bottom).toBe("calc(var(--board-title-h, 24px) - 44px)");
    expect(px(more, "width") - Number.parseFloat(left)).toBe(44);
  });

  test("the mark itself is drawn as before, and a mouse keeps the smaller area", () => {
    const more = rule(canvas, ".board-pane > .board-pane-more");
    expect(px(more, "width")).toBe(28);
    expect(rule(canvas, ".board-pane > .board-pane-more::after")).toMatch(/inset:\s*calc\(\(var\(--board-title-h, 24px\) - 44px\) \/ 2\) -8px/);
    expect(rule(coarse, ".board-pane > .board-pane-more")).toBe("");
  });

  test("zoom controls reach 44px under a finger without growing or overlapping a neighbour", () => {
    const touch = media(chrome, "(any-pointer: coarse)");
    // Fit is 36px in the phone's pill and 40px in the desk bar: centred, 44px either way.
    expect(rule(touch, ".board-body .board-zoom-fit::after")).toMatch(/inset:\s*calc\(\(100% - 44px\) \/ 2\) 0/);
    const [vertical, right, , left] = rule(touch, ".desk .board-zoom .board-zoom-step::after").match(/inset:\s*(\S+) (\S+) (\S+) (\S+);/)!.slice(1);
    const step = rule(chrome, ".desk .board-zoom .board-zoom-step");
    expect(px(step, "min-height") - 2 * Number.parseFloat(vertical)).toBe(44);
    expect(px(step, "min-width") - Number.parseFloat(left)).toBe(44);
    // Toward the percentage and the bar's edge only; Fit sits right of the second step.
    expect(right).toBe("0");
    expect(px(step, "min-width")).toBe(40);
  });

  test("the zoom bar belongs to the desk shell at every width, never to a bare width", () => {
    // From 720px the board sits in the desk shell; a phone on its side is as wide and keeps the pill.
    expect(chrome).not.toMatch(/@media[^{]*min-width/);
    const bar = rule(chrome, ".desk .board-body .board-zoom");
    expect(bar).toMatch(/right:\s*14px/);
    expect(bar).toMatch(/clip-path:\s*none/);
    // The bar's rule also names the fitted state, which hides the phone's pill.
    expect(chrome).toMatch(/\.desk \.board-body \.board-zoom\[data-at-fit\]:not\(:has\(:focus-visible\)\)\s*\{/);
    expect(rule(chrome, ".desk .board-zoom .board-zoom-step")).toMatch(/position:\s*static/);
    // Outside the shell nothing un-hides the steps or the fitted pill.
    expect(rule(chrome, ".board-body .board-zoom")).toMatch(/left:\s*50%/);
    expect(rule(chrome, ".board-body .board-zoom[data-at-fit]:not(:has(:focus-visible))")).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  test("a press on the ⋯ leaves its pane flat, so the ⋯ stays above the divider strips", () => {
    // A transformed pane is a stacking context: its ⋯ (z 5) would drop under a divider (z 4) mid-tap.
    expect(rule(canvas, ".board-pane:active")).toMatch(/transform:\s*scale\(0\.985\)/);
    const pressed = canvas.indexOf(".board-pane:active {");
    const onMore = canvas.indexOf(".board-pane:has(> .board-pane-more:active) {");
    expect(rule(canvas, ".board-pane:has(> .board-pane-more:active)")).toMatch(/transform:\s*none/);
    expect(onMore).toBeGreaterThan(pressed);
    expect(rule(canvas, ".board-pane > .board-pane-more")).toMatch(/z-index:\s*5/);
  });

  test("a finger-opened board sheet draws no keyboard ring until a key is pressed, whatever it focuses", () => {
    // Every dialog is marked by the shared lifecycle and one shared rule answers: the board keeps no copy
    // of its own, so the menu's rows, the resize steppers and the split form's tiles cannot drift from the rest.
    expect([canvas, chrome, menu].some(css => css.includes("data-quiet-focus"))).toBe(false);
    expect(rule(sheet("../../../shared/ui/styles/overlay.scss"), "dialog[data-quiet-focus] :focus-visible")).toMatch(/outline:\s*none/);
  });

  test("the way back from a pane shown alone is the tab row bar's own 44px button, for everyone", () => {
    // The bar is a canvas-mode bar and its button the bar's way out (`.board-mode-cancel`, below);
    // the canvas keeps no banner, and so no smaller button with a finger-only area around it.
    expect(canvas).not.toContain("board-zoom-banner");
    expect(rule(chrome, ".board-zoom-bar")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(chrome, ".board-zoom-bar .board-mode-cancel:disabled")).toMatch(/opacity:\s*0\.45/);
  });

  test("the resize sheet's one action fills the sheet under a finger and is the card's footer action on the desk form", () => {
    expect(rule(menu, ".board-sheet-done")).toMatch(/width:\s*100%/);
    // Every desk card's actions sit at the bottom right at their own width (shared/ui/styles/desk-dialog.scss).
    const desk = rule(menu, "dialog.modal.desk-form .board-sheet-done");
    expect(desk).toMatch(/width:\s*fit-content/);
    expect(desk).toMatch(/margin-left:\s*auto/);
    expect(desk).toMatch(/min-width:\s*5\.5rem/);
    // Finger-sized until the pointer is known to be a mouse: a card the keyboard opened on a tablet is touched afterwards.
    expect(px(desk, "min-height")).toBe(44);
    expect(px(rule(media(menu, "(hover: hover) and (pointer: fine)"), "dialog.modal.desk-form .board-sheet-done"), "min-height")).toBe(36);
  });

  test("Cancel in a canvas mode's bar is a 44px target for everyone", () => {
    const cancel = rule(chrome, ".board-mode-cancel");
    expect(px(cancel, "min-height")).toBeGreaterThanOrEqual(44);
    expect(px(cancel, "min-width")).toBeGreaterThanOrEqual(44);
  });

  test("a tab's 36px of ink already has a 44px target", () => {
    const tab = rule(chrome, ".board-shell .board-tab");
    const slop = rule(chrome, ".board-shell .board-tab::after").match(/inset:\s*(-?[\d.]+)px 0/)!;
    expect(px(tab, "min-height") - 2 * Number(slop[1])).toBeGreaterThanOrEqual(44);
  });
});
