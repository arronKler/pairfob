import { describe, expect, test } from "bun:test";
import { rowPath, rowText } from "./termrow";

describe("terminal row actions", () => {
  test("strips box gutters and decoration from both ends", () => {
    expect(rowText("│  Running the test suite   │")).toBe("Running the test suite");
    expect(rowText("▌ Allow this command?")).toBe("Allow this command?");
    expect(rowText("  • updated three files  ")).toBe("updated three files");
    expect(rowText("   ")).toBe("");
  });

  test("keeps a closing bracket that belongs to the row", () => {
    expect(rowText("● Read README.md (18 lines)")).toBe("● Read README.md (18 lines)");
    expect(rowText("│ ran build (2 warnings) │")).toBe("ran build (2 warnings)");
    expect(rowText("(orphaned by the gutter trim)")).toBe("orphaned by the gutter trim");
  });

  test("picks the copyable token on the row", () => {
    expect(rowPath("│ Edited src/app.ts:12 │")).toBe("src/app.ts:12");
    expect(rowPath("  /Users/me/projects/pairfob/README.md")).toBe("/Users/me/projects/pairfob/README.md");
    expect(rowPath("    at handler.js:3:1")).toBe("handler.js:3:1");
    expect(rowPath("docs: https://example.com/a/b#c")).toBe("https://example.com/a/b#c");
    expect(rowPath("~/.config/pairfob/state.json")).toBe("~/.config/pairfob/state.json");
  });

  test("does not invent a path", () => {
    expect(rowPath("❯ 1. Yes")).toBeNull();
    expect(rowPath("release 1.2.3 is out")).toBeNull();
    expect(rowPath("cannot find module")).toBeNull();
    expect(rowPath("")).toBeNull();
  });
});
