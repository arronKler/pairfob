import { describe, expect, test } from "bun:test";
import { compileScss } from "../../../../test-support/compiled-style";

/**
 * The session header's icon buttons carry no fill at rest. The press and
 * disabled states are drawn where the header is built; the hover is pinned
 * here, because a mouse has no other sign that a mark is a button before it
 * clicks. It is asked of a precise pointer only.
 */
const css = compileScss(new URL("../../../style.scss", import.meta.url)).css;

function finePointerRule(selector: string): string {
  // Sass keeps a nested media block expanded: match the query and the single
  // rule inside it, not a same-named rule elsewhere in the sheet.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`@media \\(hover: hover\\) and \\(pointer: fine\\) \\{\\s*${escaped} \\{([^}]*)\\}`).exec(css);
  return found?.[1] ?? "";
}

describe("the session header's icon buttons", () => {
  test("answer a precise pointer's hover before the press", () => {
    expect(finePointerRule(".chrome .icon-btn:hover:not(:disabled)"))
      .toMatch(/background:\s*var\(--surface\)/);
  });
});
