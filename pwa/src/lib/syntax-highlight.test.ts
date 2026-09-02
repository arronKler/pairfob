import { describe, expect, test } from "bun:test";
import { highlightSource } from "./syntax-highlight";

function kinds(path: string, source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const token of highlightSource(path, source)) {
    if (token.kind) (result[token.kind] ??= []).push(token.text);
  }
  return result;
}

describe("workspace syntax highlighting", () => {
  test("highlights TypeScript without changing its source text", () => {
    const source = "export const ready = true; // shipped\n";
    const tokens = highlightSource("src/app.ts", source);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(kinds("src/app.ts", source).keyword).toEqual(["export", "const"]);
    expect(kinds("src/app.ts", source).literal).toEqual(["true"]);
    expect(kinds("src/app.ts", source).comment).toEqual(["// shipped"]);
  });

  test("distinguishes JSON properties, strings, numbers, and literals", () => {
    const source = '{"name":"pairfob","enabled":true,"count":2}';
    const found = kinds("config.json", source);
    expect(found.property).toEqual(['"name"', '"enabled"', '"count"']);
    expect(found.string).toEqual(['"pairfob"']);
    expect(found.literal).toEqual(["true"]);
    expect(found.number).toEqual(["2"]);
  });

  test("keeps markup-like file content as literal token text", () => {
    const source = '<script data-value="<unsafe>">alert(1)</script>';
    const tokens = highlightSource("index.html", source);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens.filter((token) => token.kind === "tag").map((token) => token.text)).toEqual([
      '<script data-value="<unsafe>">',
      "</script>",
    ]);
  });
});
