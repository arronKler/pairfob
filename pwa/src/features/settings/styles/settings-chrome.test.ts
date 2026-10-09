import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * The settings family's back bar (Settings on the desk, the computer page,
 * quotas, the live computer list): it stays in place while the page scrolls,
 * so a long page never takes the way back with it.
 */
const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(match => ({ parts: match[1].split(",").map(part => part.trim()), body: match[2] }));
const declared = (selector: string) => blocks.filter(block => block.parts.includes(selector)).map(block => block.body).join("\n");

describe("the settings family's back bar", () => {
  test("it sticks on the phone page and in the desk's main column, opaque over what scrolls under it", () => {
    for (const selector of [".settings-page .topbar", ".main-settings .topbar"]) {
      const bar = declared(selector);
      expect(bar, selector).toMatch(/position:\s*sticky/);
      expect(bar, selector).toMatch(/background:\s*var\(--bg\)/);
      expect(bar, selector).toMatch(/z-index:\s*3/);
    }
  });

  test("it does not move when it sticks: it reaches over the page's own top padding", () => {
    // The phone page scrolls the window under 14px plus the safe area.
    const phone = declared(".settings-page .topbar");
    expect(phone).toMatch(/top:\s*0/);
    expect(phone).toMatch(/margin:\s*calc\(-14px - env\(safe-area-inset-top, 0px\)\) -18px 0/);
    expect(phone).toMatch(/padding:\s*calc\(14px \+ env\(safe-area-inset-top, 0px\)\) 18px 0/);
    expect(declared(".page")).toMatch(/padding:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 14px\) 18px/);
    // The desk column scrolls inside 22px of padding, which a sticky offset is measured within.
    const desk = declared(".main-settings .topbar");
    expect(desk).toMatch(/top:\s*-22px/);
    expect(desk).toMatch(/margin-top:\s*-22px/);
    expect(desk).toMatch(/padding-top:\s*22px/);
    expect(declared(".main-settings")).toMatch(/padding:\s*22px 26px/);
  });

  test("its title is one line that ends in an ellipsis", () => {
    for (const selector of [".settings-page .topbar-title", ".main-settings .topbar-title"]) {
      const title = declared(selector);
      expect(title, selector).toMatch(/text-overflow:\s*ellipsis/);
      expect(title, selector).toMatch(/white-space:\s*nowrap/);
      expect(title, selector).toMatch(/overflow:\s*hidden/);
    }
  });
});
