import { describe, expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

/**
 * Scrollbars under a mouse: one themed rule for every scroller, and nothing
 * for a finger, whose platform draws overlay scrollbars.
 */
const css = compile(fileURLToPath(new URL("../style.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "");
const partial = compile(fileURLToPath(new URL("./scrollbars.scss", import.meta.url)), { style: "expanded" }).css
  .replace(/\/\*[\s\S]*?\*\//g, "").trim();

const FINE = "@media (hover: hover) and (pointer: fine)";

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`(?:^|[{}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("scrollbars under a precise pointer", () => {
  test("every scroller gets the rail's thin bar over no track, from one place", () => {
    expect(declarations(partial, ":root")).toMatch(/scrollbar-color:\s*var\(--line-strong\) transparent/);
    expect(declarations(partial, "*")).toMatch(/scrollbar-width:\s*thin/);
    // The rail's own declaration is the colour this generalises.
    expect(declarations(css, ".rail-list")).toMatch(/scrollbar-color:\s*var\(--line-strong\) transparent/);
    expect(css).toContain(partial);
  });

  test("nothing applies without a precise pointer: the phone and the tablet keep overlay scrollbars", () => {
    expect(partial.startsWith(`${FINE} {`)).toBeTrue();
    // The whole partial is that one block.
    let depth = 0;
    let closedAt = -1;
    for (let index = partial.indexOf("{"); index < partial.length; index += 1) {
      if (partial[index] === "{") depth += 1;
      if (partial[index] === "}") depth -= 1;
      if (depth === 0) { closedAt = index; break; }
    }
    expect(closedAt).toBe(partial.length - 1);
  });

  test("the chat stream keeps the bar's room on both sides, so messages stay on the compose field's axis", () => {
    expect(declarations(partial, ".agent-stream")).toMatch(/scrollbar-gutter:\s*stable both-edges/);
  });

  test("a scroller that hides its bar still does: its class outranks the universal selector", () => {
    for (const selector of [".attn-strip", ".create-scroll", ".attach-strip"]) {
      expect(declarations(css, selector), selector).toMatch(/scrollbar-width:\s*none/);
    }
  });
});
