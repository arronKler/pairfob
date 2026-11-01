import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLDetailsElement",
  "HTMLAnchorElement",
  "HTMLTemplateElement",
  "Element",
  "Node",
  "Document",
  "DocumentFragment",
  "DOMParser",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;

const { renderMarkdown } = await import("./agent-markdown.ts");

describe("agent markdown", () => {
  test("renders GFM and heals incomplete emphasis while streaming", () => {
    const html = renderMarkdown("hello **world");
    expect(html).toContain("<strong>world</strong>");
    expect(renderMarkdown("- one\n- two")).toContain("<li>");
    expect(renderMarkdown("```ts\nconst x = 1\n```")).toContain("<pre>");
    expect(renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toContain("<table>");
  });

  test("strips javascript URLs", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  test("returns sanitized HTML with heading and inline formatting", () => {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown("# Title\n\nUse `Read` then **edit**.");
    const el = template.content;
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("code")?.textContent).toBe("Read");
    expect(el.querySelector("strong")?.textContent).toBe("edit");
  });
});

describe("agent markdown cache", () => {
  test("500 distinct texts rendered once are all served from the cache the second time", async () => {
    const { marked } = await import("marked");
    const { spyOn } = await import("bun:test");
    const texts = Array.from({ length: 500 }, (_, n) => `cache entry **${n}**`);
    for (const text of texts) renderMarkdown(text);
    const parse = spyOn(marked, "parse");
    try {
      for (const text of texts) renderMarkdown(text);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
