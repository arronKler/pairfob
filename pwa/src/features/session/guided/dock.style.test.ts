import { describe, expect, test } from "bun:test";

const dock = await Bun.file(new URL("./dock.scss", import.meta.url)).text();
const compose = await Bun.file(new URL("./compose.scss", import.meta.url)).text();
const rowActions = await Bun.file(new URL("./row-actions.scss", import.meta.url)).text();
const dense = await Bun.file(new URL("./dock-dense.scss", import.meta.url)).text();
const terminal = await Bun.file(new URL("./terminal.scss", import.meta.url)).text();
const attachments = await Bun.file(new URL("../../../styles/attachments.scss", import.meta.url)).text();

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`missing rule ${selector}`);
  return source.slice(start, source.indexOf("}", start));
}

const px = (declarations: string, property: string): number => {
  const match = new RegExp(`(?:^|[\\s;{])${property}:\\s*(-?\\d+)px`).exec(declarations);
  if (!match) throw new Error(`missing ${property}`);
  return Number(match[1]);
};

/**
 * Geometry the dock depends on and a test DOM cannot lay out. Each case is a
 * sum that went wrong once on a real screen.
 */
describe("the guided pad fits its scroller", () => {
  /** `inset: <top> <sides> calc(<bottom> - var(--pad-band-below))` of a control's hit area. */
  const hit = (selector: string) => {
    const match = new RegExp(`\\${selector}::before \\{ inset: (-?\\d+)px (-?\\d+)(?:px)? calc\\((-?\\d+)px - var\\(--pad-band-below\\)\\); \\}`).exec(dock);
    if (!match) throw new Error(`missing ${selector}`);
    return { top: Number(match[1]), sides: Number(match[2]), bottom: Number(match[3]) };
  };

  test("a pagination control is pressed anywhere between the keys and the compose row, and nowhere else", () => {
    const row = px(rule(dock, ".pad-pagination"), "min-height");
    const above = px(rule(dock, ".pad-pagination"), "margin-top");
    // The switch is its option inside 2px of padding and a 1px border.
    const boxes = {
      ".pad-kind-option": px(rule(dock, ".pad-kind-option"), "min-height") + 6,
      ".pad-page-dot": px(rule(dock, ".pad-page-dot"), "height"),
      ".pad-text-btn": px(rule(dock, ".pad-text-btn"), "min-height"),
    };
    for (const [selector, box] of Object.entries(boxes)) {
      const inside = (row - box) / 2 + (selector === ".pad-kind-option" ? 3 : 0);
      const area = hit(selector);
      // Up to the keys' edge and not a pixel into a key.
      expect(area.top + inside + above, selector).toBe(0);
      // Down to the row's own edge, plus the gap below it that the pad owns.
      expect(area.bottom + inside, selector).toBe(0);
    }
    // That gap is 8px down to the compose row; 2px where the row of live actions follows.
    expect(dock).toContain(".pad-pages { --pad-band-below: 2px; }");
    expect(dock).toMatch(/\.keys-wrap \.pad-pages,\n\.full-terminal-pad\[data-input-mode="compose"\] \.pad-pages \{ --pad-band-below: 8px; \}/);
    expect(px(rule(attachments, ".full-terminal-live-actions"), "padding")).toBe(2);
    // 2 + 28 + 8: all the height a mouse's compact row has between a key and the field.
    expect(above + row + 8).toBe(38);
  });

  /** The body of the coarse-pointer block that follows the hit-area rules. */
  const coarse = (source: string): string => {
    const start = source.indexOf("@media (any-pointer: coarse) {");
    if (start < 0) throw new Error("missing coarse block");
    return source.slice(start, source.indexOf("\n}\n", start));
  };

  test("under a finger the band is 44px high, taken from between the key rows and not from the terminal", () => {
    const touch = coarse(dock);
    const first = (pattern: RegExp): number => Number(pattern.exec(touch)?.[1]);
    const row = px(rule(dock, ".pad-pagination"), "min-height");
    const above = first(/\.pad-pages:not\(\.is-one-row\) > \.pad-pagination \{ margin-top: (\d+)px; \}/);
    // 8 + 28 + 8: the row in the middle of a band a finger can press.
    expect(above + row + 8).toBe(44);
    // The hit areas reach the keys' edge across the larger margin.
    for (const [selector, box] of [[".pad-kind-option", 22 + 6], [".pad-page-dot", 24], [".pad-text-btn", 28]] as const) {
      const top = first(new RegExp(`\\.pad-pages:not\\(\\.is-one-row\\) \\${selector}::before \\{ top: -(\\d+)px; \\}`));
      expect(top, selector).toBe((row - box) / 2 + (selector === ".pad-kind-option" ? 3 : 0) + above);
    }
    // What the dock spends above the row, before and after: nothing is added to its height.
    const keysPad = 2;
    const before = keysPad + 44 + keysPad + px(rule(dock, ".pad-pages"), "margin-top") + 44 + 6 + 44 + px(rule(dock, ".pad-pagination"), "margin-top");
    expect(touch).toContain(".keys:has(+ .pad-pages:not(.is-one-row)) { padding-top: 0; }");
    const gap = first(/\.keys \+ \.pad-pages:not\(\.is-one-row\) \{ margin-top: (\d+)px; \}/);
    const rows = first(/\.pad-pages:not\(\.is-one-row\) > \.pad-page \{ row-gap: (\d+)px; \}/);
    expect(44 + keysPad + gap + 44 + rows + 44 + above).toBe(before);
    // The key rows stand the same 5px apart.
    expect(keysPad + gap).toBe(rows);
    // One row to a page (a phone on its side) has the row's whole height already and keeps its own rules.
    expect(touch).not.toMatch(/\n  \.pad-pages \{/);
  });

  test("live input in the complete terminal gets the same band: 6px under the row, found above the keys", () => {
    const touch = coarse(dock);
    expect(touch).toContain('.full-terminal-pad[data-input-mode="live"] .pad-pages:not(.is-one-row) { --pad-band-below: 8px; margin-bottom: 6px; }');
    // 6 under the row and the 2 the live actions keep over themselves: the 8 the hit areas reach down.
    expect(6 + px(rule(attachments, ".full-terminal-live-actions"), "padding")).toBe(8);
    // Paid for by the pad's top padding (8 to 5) and the gap under the keyboard button (8 to 5).
    expect(touch).toContain('.full-terminal-pad[data-input-mode="live"]:has(.pad-pages:not(.is-one-row)) { padding-top: 5px; }');
    expect(touch).toContain('.full-terminal-pad[data-input-mode="live"]:has(.pad-pages:not(.is-one-row)) .full-terminal-kb { margin-bottom: 5px; }');
    expect((8 - 5) + (8 - 5)).toBe(6);
  });

  test("under a finger the tray's buttons and a thumbnail's × are 44px targets, and the tray is no taller", () => {
    const touch = coarse(attachments);
    // 28px buttons: 10 over (their label's room) and 6 under.
    expect(px(rule(attachments, ".attach-lead-btn"), "min-height") + 10 + 6).toBe(44);
    expect(touch).toContain(".attach-lead-btn::before { inset: -10px -3px -6px; }");
    expect(px(rule(attachments, ".attach-undo-btn"), "min-height") + 6 + 6).toBe(44);
    expect(touch).toContain(".attach-undo-btn::before { content: \"\"; position: absolute; inset: -6px -4px; }");
    // The × is 20px with a 2px border: 16 of padding box, plus 12 over, 16 under and 14 on each side.
    const zone = /\.attach-tray:not\(\.is-compact\) \.attach-chip-x::before \{\s*inset: -12px -14px -16px;\s*clip-path: polygon\(([^)]*)\);\s*\}/.exec(touch);
    expect(zone).not.toBeNull();
    expect(16 + 12 + 16).toBe(44);
    expect(16 + 14 + 14).toBe(44);
    // Inside the thumbnail the square is 26 by 28 of its 56: the centre (28, 28) is not the ×'s.
    expect(-6 + 2 + 16 + 14).toBe(26);
    expect(-6 + 2 + 16 + 16).toBe(28);
    // Two corners of the square are cut. In the area's own coordinates the thumbnail's corner is
    // at (18, 16) and the thumbnail before it ends at 10, across the 8px gap.
    const points = zone![1].split(",").map((point) => point.trim().split(/\s+/).map((value) => value === "100%" ? 44 : Number.parseFloat(value)));
    expect(points).toEqual([[0, 0], [44, 0], [44, 24], [24, 44], [10, 44], [10, 16], [0, 16]]);
    // Still 44 across (over the padding above the thumbnails) and 44 tall (beside the corner).
    expect(points[1][0] - points[0][0]).toBe(44);
    expect(points[3][1]).toBe(44);
    // Nothing of it lies on the thumbnail before this one: left of the gap it stops at the thumbnails' top.
    expect(points.filter(([x]) => x < 10).every(([, y]) => y <= 16)).toBeTrue();
    // Of this thumbnail it takes 26 by 28 less a 20px corner: a sixth, and the rest opens its actions.
    const taken = 26 * 28 - (20 * 20) / 2;
    expect(taken).toBe(528);
    expect(taken / (56 * 56)).toBeLessThan(0.17);
    // More than half of what is left of the area lies outside any thumbnail.
    const area = 44 * 44 - (20 * 20) / 2 - 10 * 28;
    expect((area - taken) / area).toBeGreaterThan(0.6);
    // The actions a thumbnail opens are 44px rows under a finger and stay compact under a mouse.
    expect(px(rule(attachments, ".attach-pop-act"), "min-height")).toBe(36);
    // In a block of its own after the rule it overrides: the two are equally specific.
    const rows = "@media (any-pointer: coarse) {\n  .attach-pop-act { min-height: 44px; }\n}";
    expect(attachments.indexOf(rows)).toBeGreaterThan(attachments.indexOf("\n.attach-pop-act {"));
    // The strip's box moves out by what it gains in padding, so no thumbnail moves and the tray keeps its height.
    expect(rule(attachments, ".attach-strip")).toContain("padding: 8px 2px 4px 8px");
    expect(touch).toContain(".attach-tray:not(.is-compact) > .attach-strip { margin: -8px 0 0 -10px; padding: 16px 2px 4px 18px; }");
  });

  test("a strip that continues past its box fades on that side, and only there", () => {
    const fade = (more: string) => rule(attachments, `.attach-strip[data-more="${more}"]`);
    expect(fade("end")).toMatch(/[^-]mask-image: linear-gradient\(to right, #000 calc\(100% - 28px\), transparent\);/);
    expect(fade("start")).toMatch(/[^-]mask-image: linear-gradient\(to left, #000 calc\(100% - 28px\), transparent\);/);
    expect(fade("both")).toMatch(/[^-]mask-image: linear-gradient\(to right, transparent, #000 28px, #000 calc\(100% - 28px\), transparent\);/);
    // Half a thumbnail's width: the last one in view is plainly cut, and still recognisable.
    expect(28 * 2).toBe(px(rule(attachments, ".attach-tray"), "--attach-chip"));
    expect(rule(attachments, ".attach-strip")).not.toContain("mask");
  });

  test("the band below the row is inside the guided scroller, so pressing room adds no scroll", () => {
    // The row is the last thing in `.keys-wrap` (overflow-y: auto). A hit area
    // below the scroller's box made the pad scroll by the difference and show a
    // scrollbar. The scroller's padding holds the band; its margin takes it back.
    expect(rule(dock, ".keys-wrap")).toContain("overflow-y: auto");
    expect(dock).toContain("\n.keys-wrap { padding-bottom: 8px; margin-bottom: -8px; }");
    expect(rule(dock, ".dock-form")).toContain("margin-top: var(--space-2)");
    // A phone on its side stands the form 6px off, and the scroller follows.
    expect(dense).toContain(".is-dense .keys-wrap { padding-bottom: 6px; margin-bottom: -6px; }");
    expect(dense).toMatch(/\.is-dense \.dock-form,\n\.is-dense \.full-terminal-compose-form \{ margin-top: 6px; \}/);
  });

  test("the switch and the end dots are 44px wide to press; a dot between two others keeps its 32", () => {
    expect(hit(".pad-kind-option").sides).toBe(0);
    expect(dock).toContain(".pad-kind-option:first-child::before { left: -3px; }");
    expect(dock).toContain(".pad-kind-option:last-child::before { right: -3px; }");
    // "按键" and "命令" are 42px of label each.
    expect(42 + 3).toBeGreaterThanOrEqual(44);
    const dot = px(rule(dock, ".pad-page-dot"), "width");
    expect(dock).toContain(".pad-page-dot:first-child::before { left: -12px; }");
    expect(dock).toContain(".pad-page-dot:last-child::before { right: -12px; }");
    expect(dot + 12).toBeGreaterThanOrEqual(44);
    // Where a full row leaves the dots no room, the switch is the one on top.
    expect(dock).toContain(".pad-pagination-end { position: relative; z-index: 1; }");
  });

  test("beside a single row of keys the controls are pressed over the row's whole height", () => {
    const start = dense.indexOf(".pad-pages.is-one-row :is(.pad-kind-option, .pad-page-dot, .pad-page-count, .pad-text-btn)::before {");
    expect(start).toBeGreaterThan(0);
    const area = dense.slice(start, dense.indexOf("}", start));
    expect(area).toContain("top: 50%");
    expect(area).toContain("bottom: auto");
    expect(area).toContain("height: var(--pad-key-h, 44px)");
    expect(area).toContain("translate: 0 -50%");
  });

  test("a page count stands in for dots too close to aim at, a finger wide", () => {
    const count = rule(dense, ".pad-page-count");
    expect(px(count, "min-width")).toBeGreaterThanOrEqual(44);
    expect(count).toContain("white-space: nowrap");
    // No rule draws a dot under 24px any more.
    expect(dense).not.toContain('data-dots="tight"');
    expect(dense).not.toMatch(/\.pad-page-dot \{ width: 1\dpx; \}/);
  });

  test("a command's name keeps clear of its key's border in a one-row page, and a long one ends in an ellipsis", () => {
    expect(dense).toContain(".pad-pages.is-one-row :is(.slash-cmd, .quick-cmd) { padding-inline: 5px; }");
    const name = rule(dense, ".pad-pages.is-one-row .pad-cmd-name");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("min-width: 0");
    // `/compact` is eight monospace characters: 48px at 10px, inside the 50px a 62px key leaves.
    expect(dense).toMatch(/@container pad-row \(max-width: 599\.98px\) \{\s*\.pad-pages\.is-one-row \.slash-cmd \{ font-size: 10px; \}/);
  });

  test("nor past its sides, where the page stops clipping while commands are edited", () => {
    // `.pad-pages` clips sideways until `.is-editing` lifts the clip for the ×
    // badges. From then on the 8px a text button's hit area reaches past the
    // row's end was scrollable width: 936 in a 928px pad.
    expect(rule(dock, ".pad-pages:has(> .pad-page.is-editing)")).toContain("overflow-x: visible");
    expect(dock).toContain(".keys-wrap .pad-pagination-start > .pad-text-btn:first-child::before { left: 0; }");
    expect(dock).toContain(".keys-wrap .pad-pagination-end > .pad-text-btn:last-child::before { right: 0; }");
  });
});

describe("a line that says what a dock field is for", () => {
  test("keeps to one line, so it never counts as a second line of draft", () => {
    // An English placeholder wrapped in a 177px field beside the list, and in a
    // 196px one on a 390px phone: the field measured two lines of content and
    // grew, with a scrollbar on the desk, around an empty draft.
    const line = rule(compose, "@mixin one-line");
    expect(line).toContain("white-space: nowrap");
    expect(line).toContain("overflow: hidden");
    // Every compose and live field, at every width.
    expect(compose).toContain("\n.compose-field > textarea::placeholder { @include one-line; }");
  });

  test("beside the list the cut fades; the phone's placeholder fits and is drawn as it always was", () => {
    const fade = rule(compose, "@mixin one-line-fade");
    expect(fade).toContain("@include one-line;");
    // No `text-overflow`: Chromium holds a textarea placeholder at `clip`. The cut fades.
    expect(fade).toContain("mask-image: linear-gradient(to right");
    expect(fade).not.toContain("text-overflow");
    expect(compose).toContain("\n#app.desk .compose-field > textarea::placeholder { @include one-line-fade; }");
    // A mask composites the text it covers: none on the rule the phone gets.
    expect(rule(compose, "@mixin one-line")).not.toContain("mask");
  });

  test("the echo a live field waits for is the reader's own text: it wraps, on the phone and beside the list", () => {
    const echo = rule(compose, ".dock-form.live-pending .compose-field > textarea::placeholder,\n#app.desk .dock-form.live-pending .compose-field > textarea::placeholder");
    // Undoes the one-line rule and its fade, for this state only: cut mid-word, the reader cannot see what has gone.
    expect(echo).toContain("white-space: pre-wrap");
    expect(echo).toContain("overflow: visible");
    expect(echo).toContain("mask-image: none");
    // After the rules it overrides, at their specificity or above.
    expect(compose.indexOf(".dock-form.live-pending .compose-field > textarea::placeholder,"))
      .toBeGreaterThan(compose.indexOf("#app.desk .compose-field > textarea::placeholder { @include one-line-fade; }"));
  });

  test("the live terminal's field is cut the same way as the guided live field, not with an ellipsis", () => {
    const label = rule(compose, ".full-terminal-live-label");
    expect(label).toContain("@include one-line-fade");
    // On the label, not the button: a mask there would fade the field's border.
    const button = rule(compose, ".full-terminal-live-focus");
    expect(button).not.toContain("text-overflow");
    expect(button).not.toContain("mask");
    expect(button).not.toContain("white-space");
    // And it is the same line: the field's box, its type and its grey, by name on both.
    expect(button).toContain("padding: 10px 14px");
    expect(button).toContain("font: 400 15px/1.3 var(--font)");
    expect(button).toContain("color: $field-hint");
    expect(compose).toContain("#app.desk .compose-field > textarea::placeholder { color: $field-hint; opacity: 1; }");
    // The echo a live field waits for keeps its accent over that.
    expect(compose).toContain("#app.desk .dock-form.live-pending .compose-field > textarea::placeholder { color: var(--accent); opacity: 0.82; }");
  });

  test("the line count stands clear of a mouse's scrollbar, which a capped draft brings", () => {
    // The thin bar is 11px inside a 1px border; the count's own 9px sat against it.
    const mouse = compose.slice(compose.indexOf("#app.desk .compose-lines {"));
    expect(Number(/right: (\d+)px/.exec(mouse)?.[1])).toBeGreaterThanOrEqual(16);
    expect(px(rule(compose, ".compose-lines"), "right")).toBe(9);
  });

});

describe("the keyboard's ring on the pad's small controls", () => {
  test("is drawn round what is pressed, rounded, and not on the small label's own box", () => {
    expect(dock).toContain(".pad-text-btn:focus-visible, .pad-page-dot:focus-visible { outline: none; }");
    const ring = rule(dock, ".pad-text-btn:focus-visible::after, .pad-page-dot:focus-visible::after");
    expect(ring).toMatch(/border-radius:\s*var\(--r-sm\);/);
    expect(ring).toMatch(/outline:\s*2px solid var\(--accent\);/);
    expect(ring).toMatch(/pointer-events:\s*none;/);
    // 8px past the label each side: with a 28px label that is the 44px a press has.
    expect(ring).toMatch(/inset:\s*-2px -8px;/);
    expect(px(rule(dock, ".pad-text-btn"), "min-height") + 2 * 8).toBe(44);
    // At the pad's side it reaches inward by what it cannot have outward, as the hit area does.
    expect(dock).toContain(".pad-pagination-start > .pad-text-btn:first-child:focus-visible::after { left: 0; right: -14px; }");
    expect(dock).toContain(".pad-pagination-end > .pad-text-btn:last-child:focus-visible::after { left: -14px; right: 0; }");
    // Under a finger the band is 44px (8 above and below the 28px row): the ring stands 2px inside it.
    expect(dock).toContain(".pad-pages:not(.is-one-row) .pad-text-btn:focus-visible::after { top: -6px; bottom: -6px; }");
    // The switch's options keep a ring on their own rounded box.
    expect(rule(dock, ".pad-kind-option:focus-visible")).toMatch(/outline-offset:\s*-2px/);
    expect(rule(dock, ".pad-kind-option")).toMatch(/border-radius:\s*6px;/);
  });
});

describe("the echo of live input in the buffer", () => {
  test("it never widens its row, on a phone or beside the list: it takes the room left and is cut there, or wraps where rows do", () => {
    const cut = rule(terminal, ".term:not(.wrapped) .term-line > .term-ghost");
    // No width of its own, so a long prediction adds nothing to the row or to the buffer's scroll width.
    expect(cut).toMatch(/flex:\s*1 1 0;/);
    expect(cut).toMatch(/[\s;]width:\s*0;/);
    expect(cut).toMatch(/min-width:\s*0;/);
    expect(cut).toMatch(/overflow:\s*hidden;/);
    expect(cut).toMatch(/mask-image:\s*linear-gradient\(to right/);
    const wrapped = rule(terminal, ".term.wrapped .term-line > .term-ghost");
    expect(wrapped).toMatch(/white-space:\s*pre-wrap;/);
    expect(wrapped).toMatch(/overflow-wrap:\s*anywhere;/);
    // One rule for every width: a layout-scoped copy would leave the other layout with the sideways scroll.
    expect(terminal).not.toMatch(/#app\.desk [^{]*\.term-ghost/);
    // Both outweigh the row's own `> span` rules (`flex: 0 0 auto`, `white-space: pre`) wherever they sit in the file.
    expect(rule(terminal, ".term-line > span")).toMatch(/flex:\s*0 0 auto;/);
    // The echo's own rule stays about its look; where it ends is the two rules above.
    expect(rule(terminal, ".term-ghost")).not.toMatch(/overflow|flex|width/);
  });
});

describe("what a tablet's keyboard is told in a live terminal", () => {
  test("stands in the attach row, inside its height, and the button gives it the row's width", () => {
    const hint = rule(compose, ".full-terminal-live-hint");
    expect(hint).toMatch(/flex:\s*1 1 0;/);
    expect(hint).toMatch(/max-height:\s*2lh;/);
    expect(hint).toMatch(/overflow:\s*hidden;/);
    // Two caption lines are shorter than the 46px button beside them: the row cannot grow.
    expect(hint).toMatch(/font-size:\s*var\(--text-caption\);/);
    expect(compose).toContain(".attach-btn-labeled:has(+ .full-terminal-live-hint) { flex: 0 0 auto;");
  });
});

describe("the dense pad's 36px keys", () => {
  test("are pressed over 44: the two rows tile the pad from its top edge to the compose row", () => {
    // What 320px leaves: 53 of header, 48 of scroll row and the terminal's rows, 69 of dock around two rows of keys.
    const pad = /\.dock\.is-dense,\n\.full-terminal-pad\.is-dense \{[\s\S]*?\n\}/.exec(dense)![0];
    expect(pad).toMatch(/clamp\(\s*36px,/);
    expect(pad).toMatch(/- 53px - var\(--full-terminal-min-host-height, 113px\) - 48px - 69px\) \/ 2\)/);
    // At 44 the two rows are 16px more, and the terminal has three 18–21px rows over an open pad: one would go.
    expect(320 - 53 - 69 - 2 * 36).toBe(126);
    expect(320 - 53 - 69 - 2 * 44).toBe(110);
    expect(Math.floor((126 - 48) / 21)).toBe(3);
    expect(Math.floor((110 - 48) / 21)).toBe(2);
    // The dock's own spacing is what the hit areas take.
    expect(px(pad, "padding-top")).toBe(6);
    expect(dense).toContain(".is-dense .pad-pages { margin-top: 4px; }");
    expect(dense).toMatch(/\.is-dense \.dock-form,\n\.is-dense \.full-terminal-compose-form \{ margin-top: 6px; \}/);
    // Measured from inside the key's 1px border: 6 above the first row, the 4 between the rows, 6 under the last.
    expect(dense).toContain('.is-dense .key::before { content: ""; position: absolute; inset: -3px; }');
    expect(dense).toContain(".is-dense .keys > .key::before { top: -7px; }");
    expect(dense).toContain(".is-dense .keys:has(+ .pad-pages) > .key::before { bottom: -5px; }");
    expect(dense).toContain(".is-dense .pad-page > .key::before,\n.is-dense .keys:not(:has(+ .pad-pages)) > .key::before { bottom: -7px; }");
    expect(6 + 36 + 2).toBe(44);
    expect(2 + 36 + 6).toBe(44);
    // Alone, the first row has the dock's padding above and the form's margin below.
    expect(6 + 36 + 6).toBeGreaterThanOrEqual(44);
    // Beside a key, half the 4px gap each: no press between two keys is lost.
    expect(rule(dock, ".keys")).toMatch(/gap:\s*4px;/);
    // Nothing reaches past the pad's sides, where the guided scroller would count it as content.
    expect(dense).toContain(".is-dense .keys > .key:first-child::before { left: -1px; }");
    expect(dense).toContain(".is-dense .keys > .key:last-child::before { right: -1px; }");
    // The guided scroller holds the band above the first row, and the page's own box the band under it.
    expect(dense).toContain(".is-dense .keys-wrap { padding-top: 6px; margin-top: -6px; }");
    expect(dense).toContain(".is-dense .keys-wrap:has(> .pad-pages) { padding-bottom: 0; }");
    expect(dense).toContain(".is-dense .keys-wrap > .pad-pages { padding-bottom: 6px; }");
  });
});

describe("a short field over a longer draft", () => {
  test("covers the strips that are not its whole lines, inside its border and in its own colour", () => {
    const strips = rule(compose, ".compose-field[data-cut]::before,\n.compose-field[data-cut]::after");
    expect(strips).toMatch(/inset-inline:\s*1px;/);
    expect(strips).toMatch(/background:\s*var\(--compose-cut-bg, #0a0d12\);/);
    expect(strips).toMatch(/pointer-events:\s*none;/);
    expect(compose).toContain(".compose-field[data-cut]::before { top: 1px; height: var(--compose-cut-top, 0); border-radius: 12px 12px 0 0; }");
    expect(compose).toContain(".compose-field[data-cut]::after { bottom: 1px; height: var(--compose-cut-bottom, 0); border-radius: 0 0 12px 12px; }");
    // The colour named as the fallback is the field's own, and the corners are its 13px less the border.
    expect(rule(dock, ".dock-form textarea")).toMatch(/background:\s*#0a0d12;/);
    expect(rule(dock, ".dock-form textarea")).toMatch(/border-radius:\s*13px;/);
    // The line count stays readable over the lower strip.
    expect(compose).toContain(".compose-field[data-cut] > .compose-lines { z-index: 1; }");
    // Nothing is drawn for a field that is not told it is cut: a phone held upright, a desk.
    expect(compose).not.toMatch(/\.compose-field::(before|after)/);
  });
});

describe("the dock's hint line", () => {
  test("drops a phrase that does not fit instead of cutting it mid-word", () => {
    const hint = rule(compose, ".dock-mode-hint");
    expect(hint).toContain("flex-wrap: wrap");
    expect(hint).toContain("max-height: 1lh");
    expect(hint).toContain("overflow: hidden");
    expect(hint).toContain("white-space: nowrap");
  });
});

describe("the selection hint at the bottom of the buffer", () => {
  test("leaves the top and stands clear of the scroll rail", () => {
    const below = rule(rowActions, ".select-hint.is-below");
    expect(below).toContain("top: auto");
    expect(px(below, "bottom")).toBeGreaterThan(0);
    // The rail is 44px of buttons, 4px from the edge.
    expect(below).toContain("inset-inline: 0 52px");
  });

  test("beside the list the rail stands in with the framed buffer, and the hint's room with it", () => {
    // 16px of column padding and the frame's 1px border on top of the 52px above:
    // without them an English hint ended 3px inside the rail on a portrait tablet.
    const start = dock.indexOf("> .term-stage > .select-hint.is-below {");
    const desk = dock.slice(start, dock.indexOf("}", start));
    expect(desk).toContain("inset-inline: var(--space-4) calc(var(--space-4) + 53px)");
    expect(desk).toContain("max-width: calc(100% - 2 * var(--space-4) - 73px)");
  });
});

describe("the selection hint beside a rail that lies under the buffer", () => {
  test("sits in the rail's row, no taller than it, between the measured insets", () => {
    const beside = rule(rowActions, ".select-hint.is-beside-rail");
    expect(beside).toContain("top: auto");
    expect(beside).toContain("bottom: 0;");
    expect(beside).toContain("left: var(--select-hint-start)");
    expect(beside).toContain("right: var(--select-hint-end)");
    // The Done button is the rail's 44px; padding would push the pill up over the last row.
    expect(beside).toContain("padding-block: 0");
    expect(px(rule(rowActions, ".select-done"), "min-height")).toBe(44);
    // The desk's top offset must not apply as well, or the pill stretches between both.
    expect(dock).toContain("> .term-stage > .select-hint:not(.is-below, .is-beside-rail) {");
  });

  test("a hint too long for its room takes a second line before it loses a word", () => {
    const label = rule(rowActions, ".select-hint-label");
    expect(label).toContain("-webkit-line-clamp: 2");
    expect(label).not.toContain("white-space: nowrap");
  });
});
