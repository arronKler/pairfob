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

const { markdownEl, renderMarkdown } = await import("./agent-markdown.ts");

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

  test("mounts sanitized nodes", () => {
    const el = markdownEl("# Title\n\nUse `Read` then **edit**.");
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("code")?.textContent).toBe("Read");
    expect(el.querySelector("strong")?.textContent).toBe("edit");
  });
});
