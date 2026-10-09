import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

const sheet = (name: string) => compile(fileURLToPath(new URL(name, import.meta.url)), { style: "expanded" }).css;
const board = sheet("./board.scss");
const chrome = sheet("./board-chrome.scss");
const overlays = sheet("./board-overlays.scss");
const canvas = sheet("./board-canvas.scss");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`))?.[1] ?? "";
}

/**
 * What the board says while it is used never sits on the stage and never
 * takes a touch meant for it: status feedback floats outside the canvas's
 * middle, and a canvas mode speaks in the tab row.
 */
describe("board feedback stays off the stage", () => {
  test("a line of feedback takes no touch; only the offer with buttons does", () => {
    expect(rule(board, ".board-float")).toMatch(/pointer-events:\s*none/);
    expect(rule(board, ".board-float > *")).toMatch(/pointer-events:\s*none/);
    expect(rule(board, ".board-float > .board-created-notice")).toMatch(/pointer-events:\s*auto/);
  });

  test("on an upright phone it sits over the bottom of the canvas, measured from the canvas's own edge", () => {
    const float = rule(board, ".board-float");
    // A row of no height after the canvas, growing upwards: the tab bar's room below is not its business.
    expect(float).toMatch(/position:\s*relative/);
    expect(float).toMatch(/height:\s*0/);
    expect(float).toMatch(/justify-content:\s*flex-end/);
    expect(float).toMatch(/bottom:\s*68px/);
  });

  test("where the board is as tall as its window it goes to the header row instead", () => {
    const header = /position:\s*absolute;\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 6px\);[^}]*bottom:\s*auto;[^}]*height:\s*auto/;
    expect(rule(board, ".desk .board-float")).toMatch(header);
    const short = board.slice(board.indexOf("@media (max-height: 500px)"));
    expect(rule(short, ".board-float")).toMatch(header);
  });

  test("in the header row it has the trailing end to itself: the title keeps to the rest, at any width", () => {
    const short = board.slice(board.indexOf("@media (max-height: 500px)"));
    for (const [css, shell, float] of [[board, ".desk .board-shell", ".desk .board-float"], [short, ".board-shell", ".board-float"]] as const) {
      // One measure for both: what the feedback may take is what the title gives up while it shows.
      expect(rule(css, shell)).toMatch(/--board-float-room:\s*min\(26rem, 55%\)/);
      const placed = rule(css, float);
      expect(placed).toMatch(/right:\s*56px/);
      expect(placed).toMatch(/left:\s*auto/);
      expect(placed).toMatch(/justify-content:\s*flex-end/);
      expect(placed).toMatch(/width:\s*max-content;\s*max-width:\s*var\(--board-float-room\)/);
      expect(rule(css, `${shell}:has(> .board-float > *) .board-title`)).toMatch(/margin-right:\s*calc\(var\(--board-float-room\) \+ 12px\)/);
    }
    // An upright phone keeps the whole header for its title: nothing is reserved there.
    const upright = board.slice(0, board.indexOf(".desk .board-shell"));
    expect(upright).not.toMatch(/board-title/);
    expect(upright).not.toMatch(/--board-float-room:/);
  });

  test("a canvas mode's hint takes the tab row, which keeps its height", () => {
    const mode = rule(chrome, ".board-mode");
    expect(mode).toMatch(/position:\s*absolute/);
    expect(mode).toMatch(/display:\s*none/);
    // Shown for a placement and for a lifted tile; the tabs under it are hidden, not removed.
    expect(chrome).toMatch(/\.board-rail:has\(\.board-mode > \.board-place-banner\) > \.board-mode,\s*\.board-shell:has\(\.board-pane\[data-board-lift\]\) \.board-mode\s*\{\s*display:\s*flex/);
    expect(chrome).toMatch(/\.board-shell:has\(\.board-pane\[data-board-lift\]\) \.board-rail > :not\(\.board-mode\)\s*\{\s*visibility:\s*hidden/);
    // Held in place and dragged are two lines; each shows for its own mark.
    expect(chrome).toMatch(/\[data-board-lift=""\]\) \.board-mode-lift\.is-held,\s*\.board-shell:has\(\.board-pane\[data-board-lift=moved\]\) \.board-mode-lift\.is-moved\s*\{\s*display:\s*flex/);
    expect(rule(chrome, ".board-mode-lift")).toMatch(/display:\s*none/);
  });

  test("a pane shown alone keeps the tabs: its bar shares their row, or takes the line under it", () => {
    // The row wraps only while it holds the bar, so every other board keeps its one line.
    expect(rule(chrome, ".board-shell .board-rail:has(> .board-zoom-bar)")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(chrome, ".board-shell .board-rail")).not.toMatch(/flex-wrap/);
    // The strip asks for the room its tabs take, so the line breaks before a tab is cut, and it takes
    // all the row has to spare. No width is named: the row measures itself.
    const tabs = rule(chrome, ".board-rail:has(> .board-zoom-bar) > .board-tabs");
    expect(tabs).toMatch(/flex:\s*9999 1 auto/);
    expect(tabs).not.toMatch(/min-width/);
    expect(chrome).not.toMatch(/board-zoom-bar[^{]*\{[^}]*\d{3}px/);
    // More tabs than the row holds: the strip stops short of "+" and scrolls; "+" never drops a line.
    expect(tabs).toMatch(/max-width:\s*100%/);
    expect(rule(chrome, ".board-rail:has(> .board-zoom-bar):has(> .board-tab-new) > .board-tabs"))
      .toMatch(/max-width:\s*calc\(100% - 46px - var\(--space-2\)\)/);
    // It hides nothing: only a placement or a lift takes the tabs away.
    expect(chrome).not.toMatch(/board-zoom-bar[^{]*\{[^}]*visibility/);
    // A mode's hint is one line high, whatever stands under the tabs.
    expect(rule(chrome, ".board-mode")).toMatch(/inset:\s*2px 16px auto;\s*height:\s*46px/);
  });

  test("only a canvas without that row draws the placement hint on itself", () => {
    expect(rule(overlays, ".board-canvas > .board-place-banner")).toMatch(/position:\s*absolute/);
    expect(rule(overlays, ".board-place-banner")).toBe("");
  });

  test("the empty card stands in the canvas's middle, a little above it, and stays a card on a wide canvas", () => {
    const empty = rule(canvas, ".board-canvas > .empty");
    // The page's side padding on a phone, a card and not a band beside the list.
    expect(empty).toMatch(/width:\s*min\(460px, 100% - 32px\)/);
    expect(empty).toMatch(/margin:\s*0 auto/);
    // The free height is shared two parts above to three below.
    expect(rule(canvas, ".board-canvas:has(> .empty)")).toMatch(/display:\s*flex;\s*flex-direction:\s*column/);
    expect(canvas).toMatch(/\.board-canvas:has\(> \.empty\)::before,\s*\.board-canvas:has\(> \.empty\)::after\s*\{[^}]*flex:\s*2 1 0/);
    expect(canvas).toMatch(/\.board-canvas:has\(> \.empty\)::after\s*\{\s*flex-grow:\s*3/);
    // A canvas shorter than the card scrolls to the action instead of cutting it.
    expect(rule(canvas, ".board-canvas:has(> .empty)")).toMatch(/overflow-y:\s*auto;\s*touch-action:\s*pan-y/);
  });
});
