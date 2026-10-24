import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";
import { fullTerminalOptions } from "./full-terminal-renderer";

const css = compile(fileURLToPath(new URL("./full-terminal.scss", import.meta.url)), { style: "expanded" }).css;
const xtermCss = await Bun.file(new URL("../../../../node_modules/@xterm/xterm/css/xterm.css", import.meta.url)).text();

/** Every `selector { body }` of a flat stylesheet, comments dropped. */
function rules(source: string): Array<{ selectors: string[]; body: string }> {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selectors: selector.split(",").map((part) => part.trim()), body }));
}

/** A custom property declared on the terminal root, which is where the plate and its ink live. */
function rootVariable(name: string): string {
  // The rules helper keeps the whole body; the property may start the block or
  // follow another declaration, so both boundaries are accepted.
  // The compiled sheet opens with an `@charset` rule, so the first selector
  // carries that preamble rather than standing alone.
  const body = rules(css).find((rule) => rule.selectors.some((selector) => selector.includes(".full-terminal-root")))?.body ?? "";
  const value = body.match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`))?.[1];
  return value ? value.trim() : "";
}

/**
 * The colour a declaration resolves to. The terminal states its plate and its
 * ink as custom properties on `.full-terminal-root`, so a rule that reads one
 * is compared by the value a reader sees, not by the reference.
 */
function resolved(source: string, selector: string, property: string): string {
  const value = declared(source, selector, property);
  return value.replace(/var\((--[\w-]+)\)/g, (whole, name) => rootVariable(name) || whole);
}

function declared(source: string, selector: string, property: string): string {
  for (const rule of rules(source)) {
    if (!rule.selectors.includes(selector)) continue;
    const value = rule.body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`))?.[1];
    if (value) return value.trim();
  }
  return "";
}

const classes = (selector: string): number => selector.match(/\.[\w-]+/g)?.length ?? 0;

describe("complete terminal layers", () => {
  test("xterm's own layers cannot rise over the state layer or the scroll rail", () => {
    // xterm positions these inside `.xterm`, which makes no stacking context of its own.
    const xtermLayers = rules(xtermCss).flatMap((rule) => rule.body.match(/z-index:\s*(-?\d+)/)?.[1] ?? []).map(Number);
    expect(Math.max(...xtermLayers)).toBeGreaterThanOrEqual(Number(declared(css, ".full-terminal-state", "z-index")));
    // So the wrapper around the mount has to contain them, inside the host's own context.
    expect(declared(css, ".full-terminal-pan", "isolation")).toBe("isolate");
    expect(declared(css, ".full-terminal-host", "isolation")).toBe("isolate");
    expect(Number(declared(css, ".full-terminal-state", "z-index"))).toBeGreaterThan(0);
    expect(Number(declared(css, ".full-terminal-scroll", "z-index")))
      .toBeGreaterThan(Number(declared(css, ".full-terminal-state", "z-index")));
  });

  test("the viewport takes the terminal background whichever stylesheet loads last", () => {
    const theirs = rules(xtermCss).filter((rule) => rule.selectors.some((selector) => selector.endsWith(".xterm-viewport"))
      && /background-color|overflow/.test(rule.body));
    expect(theirs.length).toBeGreaterThan(0);
    const ours = ".full-terminal-host .xterm .xterm-viewport";
    for (const rule of theirs) {
      for (const selector of rule.selectors) expect(classes(ours)).toBeGreaterThan(classes(selector));
    }
    expect(declared(css, ours, "overflow")).toBe("hidden");
    // The colour the host is painted and the theme draws the rows on.
    const theme = fullTerminalOptions({ fontFamily: "monospace", fontSize: 13, lineHeight: 1, linkHandler: { activate() {} } }).theme;
    expect(resolved(css, ours, "background-color")).toBe(theme?.background ?? "");
    expect(resolved(css, ".full-terminal-host", "background")).toBe(theme?.background ?? "");
  });
});
