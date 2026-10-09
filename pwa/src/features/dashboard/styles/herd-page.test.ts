import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/** Finger-sized targets on the phone list. The boxes are measured in a browser; the rules they rest on are pinned here. */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(",").map(part => part.trim().replace(/\s+/g, " ")).includes(selector)).map(match => match[2]).join("\n");

describe("phone list targets", () => {
  test("a needs-you ticket is drawn 36px and takes a press over 44", () => {
    const drawn = Number(rules(".attn-ticket").match(/min-height:\s*(\d+)px/)![1]);
    const border = 1;
    expect(drawn).toBe(36);
    expect(rules(".herd-page .attn-ticket")).toMatch(/position:\s*relative/);
    const reach = rules(".herd-page .attn-ticket::after");
    expect(reach).toMatch(/position:\s*absolute/);
    const [block, inline] = reach.match(/inset:\s*-(\d+)px -(\d+)px/)!.slice(1).map(Number);
    // The reach is measured from inside the border.
    expect(drawn - 2 * border + 2 * block).toBeGreaterThanOrEqual(44);
    // It stays inside the strip's own padding and short of the next ticket.
    const [top, , bottom] = rules(".attn-strip").match(/padding:\s*(\d+)px (\d+)px (\d+)px/)!.slice(1).map(Number);
    expect(block - border).toBeLessThanOrEqual(Math.min(top, bottom));
    expect(inline).toBeLessThan(Number(rules(".attn-strip").match(/gap:\s*(\d+)px/)![1]) / 2);
    // The rail's ticket is a full 44px and needs none of it.
    expect(rules(".rail .attn-ticket")).toMatch(/min-height:\s*44px/);
    expect(rules(".rail .attn-ticket::after")).toBe("");
  });

  test("the path line under a heading lets a press through to the title and tools it overlaps", () => {
    // Pulled up under the title's row, it lies over the lower edge of the 44px controls beside it.
    expect(rules(".group-path")).toMatch(/margin:\s*-8px 0 0 28px/);
    expect(rules(".herd-page .group-path")).toMatch(/pointer-events:\s*none/);
    expect(rules(".icon-btn")).toMatch(/min-(?:width|height):\s*44px/);
  });
});
