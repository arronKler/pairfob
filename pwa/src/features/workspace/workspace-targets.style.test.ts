import { describe, expect, test } from "bun:test";

const shell = await Bun.file(new URL("./workspace.scss", import.meta.url)).text();
const browse = await Bun.file(new URL("./workspace-browse.scss", import.meta.url)).text();
const detail = await Bun.file(new URL("./workspace-detail.scss", import.meta.url)).text();
const inspector = await Bun.file(new URL("./workspace-inspector.scss", import.meta.url)).text();

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

/** The body of the block a finger gets: everything but a hovering, precise pointer. */
function coarse(source: string): string {
  const open = "@media not all and (hover: hover) and (pointer: fine) {";
  const blocks = source.split(open).slice(1).map((rest) => rest.slice(0, rest.indexOf("\n}\n")));
  if (!blocks.length) throw new Error("no coarse-pointer block");
  return blocks.join("\n");
}

const TARGET = 44;

/**
 * The files screen draws its tabs, its layer switch and its info-bar chips
 * smaller than a finger's target. Their hit areas make up the difference, and
 * these are the sums that keep each one a whole target that touches nothing
 * else: a test DOM lays nothing out.
 */
describe("the files screen's small controls under a finger", () => {
  test("a tab is pressed 44px high, inside the room the strip leaves around it", () => {
    const ink = px(rule(shell, ".workspace-tab"), "min-height");
    const reach = /\.workspace-tab::after \{ content: ""; position: absolute; inset: -(\d+)px 0; \}/.exec(coarse(shell));
    if (!reach) throw new Error("missing the tab's hit area");
    expect(coarse(shell)).toContain(".workspace-tab { position: relative; }");
    expect(ink + 2 * Number(reach[1])).toBe(TARGET);
    // Above is the header and below the list: the strip's padding and margin are the only room.
    const strip = rule(shell, ".workspace-tabs");
    expect(px(strip, "padding") + px(strip, "margin")).toBeGreaterThanOrEqual(Number(reach[1]));
    // Sideways the tabs are 3px apart, so the area never widens.
    expect(reach[0]).toContain("px 0;");
  });

  test("a chip and a layer are pressed 44px high, centred, inside the info bar", () => {
    const block = coarse(detail);
    expect(block).toContain(".workspace-chip,\n  .workspace-layer-switch button { position: relative; }");
    // max(own height, 44px) about the centre: 6px past a 32px chip, 8px past a 28px layer.
    expect(block).toContain(
      `.workspace-chip::after,\n  .workspace-layer-switch button::after { content: ""; position: absolute; inset: min(0px, calc(50% - ${TARGET / 2}px)) 0; }`,
    );
    expect(px(rule(detail, ".workspace-chip"), "min-height")).toBeLessThan(TARGET);
    expect(px(rule(detail, ".workspace-layer-switch button"), "min-height")).toBeLessThan(TARGET);
    // The bar clips what leaves it, and the header sits right above: the area has to fit inside.
    const bar = rule(detail, ".workspace-detail-head");
    expect(bar).toMatch(/overflow:\s*hidden/);
    expect(bar).toMatch(/align-items:\s*center/);
    expect(px(bar, "min-height") - 1).toBeGreaterThanOrEqual(TARGET);
  });

  test("the inspector's own 44px controls gain nothing from it", () => {
    // Already a whole target there, so `min(0px, …)` is 0 and the area is the control.
    const block = coarse(inspector);
    expect(block).toMatch(/\.workspace-inspector \.workspace-layer-switch button \{ min-width: 44px; min-height: 44px; \}/);
    expect(block).toMatch(/\.workspace-inspector \.workspace-chip \{ min-height: 44px; \}/);
  });

  test("a mouse keeps the drawn size as its target", () => {
    const outside = (source: string): string => source.split("@media not all and (hover: hover) and (pointer: fine) {")[0];
    expect(outside(shell)).not.toContain(".workspace-tab::after");
    expect(outside(detail)).not.toContain(".workspace-chip::after");
    expect(detail.match(/workspace-chip::after/g)).toHaveLength(1);
    expect(shell.match(/workspace-tab::after/g)).toHaveLength(1);
    // The areas added for the trail, a note's actions, Send and Retry are a finger's too.
    for (const [source, mark] of [
      [browse, ".workspace-up::after"], [browse, ".workspace-crumb::after"], [detail, ".btn.diff-note-action::after"],
      [detail, ".workspace-shell .btn.workspace-notes-send"], [shell, ".workspace-feedback .btn::after"],
    ] as const) {
      expect(coarse(source)).toContain(mark);
      expect(coarse(source).split(mark)).toHaveLength(source.split(mark).length);
    }
  });
});

/**
 * The rest of the files screen's controls drawn under 44px: Up and the trail's
 * folders, a saved note's Edit and Delete, Send, and the small button of an
 * error. Each is pressed 44px under a finger by an area nothing draws, sized
 * to the room its own bar leaves so that it meets no neighbour's.
 */
describe("the files screen's remaining small controls under a finger", () => {
  /** `min(0px, calc(50% - Npx))` grows a box of `size` by this much on that side. */
  const reach = (size: number, half: number): number => Math.max(0, half - size / 2);

  test("Up and a folder of the trail are pressed the whole height of their bar, and no more", () => {
    const block = coarse(browse);
    expect(block).toContain(".workspace-up,\n  .workspace-crumb { position: relative; }");
    // One pixel deeper below than above: the bar's hairline is its last row.
    expect(block).toContain("inset: min(0px, calc(50% - 21.5px)) 0 min(0px, calc(50% - 22.5px));");
    const bar = px(rule(browse, ".workspace-breadcrumbs"), "min-height");
    expect(bar).toBe(TARGET);
    for (const size of [px(rule(browse, ".workspace-up"), "height"), px(rule(browse, ".workspace-crumb"), "min-height")]) {
      expect(size).toBeLessThan(TARGET);
      expect(size + reach(size, 21.5) + reach(size, 22.5)).toBe(bar);
      // Centred in the 43px above the hairline, the area starts at the bar's top edge.
      expect((bar - 1 - size) / 2 - reach(size, 21.5)).toBe(0);
    }
  });

  test("Up takes the bar's padding beside it, and the current folder the free room after it", () => {
    const block = coarse(browse);
    expect(block).toContain(".workspace-up::after { left: min(0px, calc(100% - 44px)); }");
    // 40px wide, 4px from the bar's edge: the area ends at the edge and at the first folder.
    const padding = /padding:\s*0 8px 0 (\d+)px/.exec(rule(browse, ".workspace-breadcrumbs"));
    expect(TARGET - px(rule(browse, ".workspace-up"), "width")).toBe(Number(padding?.[1]));
    expect(block).toContain(".workspace-crumb.is-current::after { right: min(0px, calc(100% - 44px)); }");
    // Sideways a folder above the current one keeps its box: the next control is a separator away.
    expect(block).not.toMatch(/\.workspace-crumb::after \{[^}]*(left|right):/);
  });

  test("a folder's name is cut inside its button, so the button's area is not cut with it", () => {
    const crumb = rule(browse, ".workspace-crumb");
    expect(crumb).not.toMatch(/overflow/);
    // The label covers the button's padding, so it cuts the name at the button's edge, as the button did.
    expect(browse).toContain(".workspace-crumb-label { display: block; margin: 0 -6px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; }");
    expect(crumb).toMatch(/padding:\s*0 6px;/);
    // The trail still cuts a path too long for it, sideways only.
    expect(rule(browse, ".workspace-crumbs")).toMatch(/overflow:\s*hidden/);
    expect(coarse(browse)).toContain(".workspace-crumbs { overflow: clip visible; }");
  });

  test("a saved note's Edit and Delete reach up to its words and down to the card's edge", () => {
    const block = coarse(detail);
    expect(block).toContain(".btn.diff-note-action { position: relative; }");
    expect(block).toContain("inset: min(0px, calc((100% - 44px) * 0.4)) 0 min(0px, calc((100% - 44px) * 0.6));");
    const drawn = px(rule(detail, ".btn.diff-note-action"), "min-height");
    const [up, down] = [(TARGET - drawn) * 0.4, (TARGET - drawn) * 0.6];
    expect(drawn + up + down).toBe(TARGET);
    const card = rule(detail, ".workspace-diff-note");
    // Up: the gap to the note's words, which are a press of their own.
    expect(up).toBe(px(card, "gap"));
    // Down: the card's padding and its 1px edge, then into its margin and short of the next line.
    const [, , bottomPadding] = /padding:\s*(\d+)px (\d+)px (\d+)px/.exec(card)!.slice(1).map(Number);
    const [, , bottomMargin] = /margin:\s*(\d+)px (\d+)px (\d+)px/.exec(card)!.slice(1).map(Number);
    expect(down).toBeGreaterThan(bottomPadding + 1);
    expect(down).toBeLessThan(bottomPadding + 1 + bottomMargin);
  });

  test("Send is its own 44px box: a clear border the margins take back, around the button as drawn", () => {
    const send = coarse(detail).slice(coarse(detail).indexOf(".workspace-shell .btn.workspace-notes-send {"));
    const drawn = px(rule(detail, ".btn.workspace-notes-send"), "min-height");
    expect(px(send, "min-height")).toBe(TARGET);
    expect(send).toMatch(/border-width:\s*2px 0;/);
    expect(send).toMatch(/margin-block:\s*-2px;/);
    expect(TARGET - 2 * 2).toBe(drawn);
    // The side borders it gave up are padding now, and the corners are the drawn ones inside the border.
    expect(px(send, "padding-inline")).toBe(16 + 1);
    expect(send).toMatch(/border-radius:\s*14px \/ 16px;/);
    expect(send).toMatch(/background-clip:\s*padding-box;/);
    // It fits the bar's padding, so the bar is as high as it was.
    expect(/padding:\s*(\d+)px/.exec(rule(detail, ".workspace-notes-bar"))![1]).toBe("8");
  });

  test("the small button of an error is pressed 44px, inside the room around it", () => {
    const block = coarse(shell);
    expect(block).toContain(".workspace-feedback .btn { position: relative; }");
    expect(block).toContain('.workspace-feedback .btn::after { content: ""; position: absolute; inset: min(0px, calc(50% - 22px)) 0; }');
    const drawn = px(shell.slice(shell.indexOf(".workspace-feedback-bar .btn {")), "min-height");
    expect(drawn).toBeLessThan(TARGET);
    // The bar's own padding is the room above and below it.
    expect(px(rule(shell, ".workspace-feedback-bar"), "padding")).toBeGreaterThanOrEqual((TARGET - drawn) / 2);
  });

  test("the receipt's way back is a chip, and has the chip's 44px already", () => {
    // `workspace-chip workspace-notes-terminal`: covered by the chip's own area above.
    expect(coarse(detail)).toContain(".workspace-chip::after");
  });
});
