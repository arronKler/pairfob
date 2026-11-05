import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * A fade between pages at one depth moves the page, not what stays beside it.
 * What is seen is checked in a browser; the rules it rests on are pinned here.
 */
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(match => ({ selectors: match[1].split(",").map(part => part.trim().replace(/\s+/g, " ").replace(/"/g, "")), body: match[2] }));
const bodyOf = (selector: string) => rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.body).join("\n");

describe("the arriving screen", () => {
  test("under the tab bar and beside the rail only the page fades: the bar and the rail are not its children's siblings in the move", () => {
    for (const kind of ["fade", "expand"]) {
      const marked = `html[data-fallback-transition=${kind}]`;
      expect(bodyOf(`${marked} #app.tabs > :not(.tab-bar)`)).toMatch(/animation:\s*screen-fade var\(--dur-3\) var\(--ease\)/);
      expect(bodyOf(`${marked} #app.desk > :not(.rail)`)).toMatch(/animation:\s*screen-fade var\(--dur-3\) var\(--ease\)/);
      // A shell with neither still arrives whole; no rule fades `#app` itself under the bar or beside the rail.
      expect(bodyOf(`${marked} #app:not(.tabs):not(.desk)`)).toMatch(/animation:\s*screen-fade/);
      expect(bodyOf(`${marked} #app`)).toBe("");
    }
  });

  test("a move inside what stays on screen leaves that part alone: the session's header, the tab bar under a deeper page", () => {
    expect(bodyOf("html[data-fallback-transition=view] .pane-root > :not(.chrome)")).toMatch(/animation:\s*screen-fade var\(--dur-3\) var\(--ease\)/);
    expect(bodyOf("html[data-fallback-transition=page-push] #app.tabs > :not(.tab-bar)")).toMatch(/animation:\s*screen-from-right var\(--dur-4\) var\(--ease\)/);
    expect(bodyOf("html[data-fallback-transition=page-pop] #app.tabs > :not(.tab-bar)")).toMatch(/animation:\s*screen-forward var\(--dur-4\) var\(--ease\)/);
    // Nothing moves `#app` whole, or the header, for these.
    for (const kind of ["view", "page-push", "page-pop"]) expect(bodyOf(`html[data-fallback-transition=${kind}] #app`)).toBe("");
  });

  test("a reader who asked for less motion gets none of it, page or shell", () => {
    const off = rules.filter(rule => rule.selectors.includes("html[data-fallback-transition] #app"));
    expect(off).toHaveLength(1);
    expect(off[0].selectors).toContain("html[data-fallback-transition] #app.tabs > :not(.tab-bar)");
    expect(off[0].selectors).toContain("html[data-fallback-transition] #app.desk > :not(.rail)");
    expect(off[0].body).toMatch(/animation:\s*none/);
  });

  test("a tab answers a switch in the time of a press, on the phone's bar and in the rail's foot", () => {
    expect(bodyOf(".tab-bar-item")).toMatch(/transition:\s*color var\(--dur-1\) var\(--ease\)/);
    expect(bodyOf(".rail-nav-item")).toMatch(/transition:\s*color var\(--dur-1\) var\(--ease\)/);
  });
});
