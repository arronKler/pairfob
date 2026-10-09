import { describe, expect, test } from "bun:test";
import { compile, compileString } from "sass";
import { fileURLToPath } from "node:url";

const css = compile(fileURLToPath(new URL("../../../style.scss", import.meta.url)), { style: "expanded" }).css;

/** The stylesheet a viewport under the desk breakpoint can match: every 900px block removed. */
function phoneCss(): string {
  let rest = css;
  for (;;) {
    const start = rest.search(/@media[^{]*\(min-width: 900px\)[^{]*\{/);
    if (start < 0) return rest;
    let depth = 0;
    let end = rest.indexOf("{", start);
    for (; end < rest.length; end++) {
      if (rest[end] === "{") depth++;
      if (rest[end] === "}" && --depth === 0) break;
    }
    rest = rest.slice(0, start) + rest.slice(end + 1);
  }
}

describe("the wide connect page and the wide picker leave the phone alone", () => {
  const phone = phoneCss();

  test("no two-column rule can match under the desk breakpoint", () => {
    for (const selector of [".is-wide", ".connect-wide", ".connect-intro", ".connect-side", ".computer-pick"]) {
      expect(phone, selector).not.toContain(selector);
    }
  });

  test("the phone page still pins its actions to the floor of a full-height column", () => {
    expect(phone).toMatch(/\.page\.connect-page\s*\{[^}]*min-height:\s*100dvh/);
    expect(phone).toMatch(/\.connect-actions\s*\{[^}]*margin-top:\s*auto/);
  });

  test("the wide page centres two columns", () => {
    expect(css).toMatch(/\.connect-wide\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 24rem\)/);
  });
});

/** The steps partial on its own, comments dropped: every rule the one-column page added. */
function stepsSelectors(): string[] {
  const partial = compileString('@use "connect-steps" as steps; @include steps.connect-steps;', {
    style: "expanded", loadPaths: [fileURLToPath(new URL(".", import.meta.url))],
  }).css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...partial.matchAll(/([^{}]+)\{/g)]
    // A comma inside :is(…) belongs to one selector.
    .flatMap(match => match[1].split(/,(?![^()]*\))/))
    .map(selector => selector.trim())
    .filter(selector => selector && !selector.startsWith("@"));
}

describe("the spelled-out pieces are not behind a width query: a mouse gets them in a narrow window", () => {
  const phone = phoneCss();

  test("the steps, the command and the card are styled below the two-column breakpoint", () => {
    expect(phone).toMatch(/\.connect-steps\s*\{[^}]*list-style:\s*none/);
    expect(phone).toMatch(/\.connect-command\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/);
    expect(phone).toMatch(/\.connect-card\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(phone).toContain(":is(.pair-code-sheet, .connect-card) input.pair-code-input {");
  });

  test("a finger-sized copy button unless a mouse points, at any width", () => {
    expect(css).toMatch(/\.connect-command-copy\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.connect-command-copy\s*\{[^}]*min-height:\s*32px/);
  });

  test("the one-column page is a class the pointer picks, with the card under the steps", () => {
    expect(phone).toMatch(/\.page\.connect-page\.is-stacked\s*\{[^}]*max-width:\s*28rem/);
    expect(phone).toMatch(/\.is-stacked > \.connect-copy\s*\{[^}]*margin-top:\s*auto/);
    expect(phone).toMatch(/\.is-stacked > \.connect-card\s*\{[^}]*margin-top:\s*26px/);
  });

  test("none of it reaches the touch page: every rule needs a class that page never renders", () => {
    // `connect-page.test` holds the other half: the touch page renders none of these classes.
    const absent = /\.(is-stacked|connect-steps|connect-step|connect-step-(n|body|note)|connect-command(-prompt|-copy)?|connect-phone-note|connect-card)(?![\w-])/;
    const selectors = stepsSelectors();
    expect(selectors.length).toBeGreaterThan(15);
    for (const selector of selectors) expect(absent.test(selector), selector).toBeTrue();
  });
});
