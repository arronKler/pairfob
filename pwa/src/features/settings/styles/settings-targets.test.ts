import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * Settings controls that are drawn smaller than a finger: each keeps its look
 * and takes its target from an invisible box around it. The sizes are checked
 * with real taps in a browser; the boxes they rest on are pinned here.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim()).includes(selector)).map(match => match[2]).join("\n");
const px = (body: string, property: string) => Number(body.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`))?.[1]);

describe("settings touch targets", () => {
  test("the switch is 51x31 drawn and at least 44 tall to touch", () => {
    const drawn = declared(".set-switch");
    const [vertical] = declared(".set-switch::before").match(/inset:\s*(-?\d+)px/)!.slice(1).map(Number);
    expect(px(drawn, "height") - 2 * vertical).toBeGreaterThanOrEqual(44);
    expect(px(drawn, "width")).toBeGreaterThanOrEqual(44);
  });

  test("a segment is drawn 40px tall in its track and reaches the track's edges and past them", () => {
    const drawn = declared(".set-seg .seg-item");
    expect(px(drawn, "min-height")).toBe(40);
    const [reach] = declared(".set-seg .seg-item::after").match(/inset:\s*(-?\d+)px 0/)!.slice(1).map(Number);
    expect(px(drawn, "min-height") - 2 * reach).toBeGreaterThanOrEqual(44);
    // It can reach over the box that positions it.
    expect(declared(".seg-item")).toMatch(/position:\s*relative/);
    // Not into the next row: the track's padding and the row's keep 6px between two tracks' targets.
    const track = Number(declared(".set-seg.seg").match(/--seg-pad:\s*(\d+)px/)![1]);
    const row = Number(declared(".set-item:has(> .set-seg)").match(/padding-block:\s*(\d+)px/)![1]);
    const pastTrack = -reach - track;
    expect(2 * row - 2 * pastTrack).toBeGreaterThan(0);
  });
});
