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

describe('opt-in chat file references', () => {
  const links = (source: string) => {
    const template = document.createElement('template');
    template.innerHTML = renderMarkdown(source, true);
    return [...template.content.querySelectorAll('a[data-file-ref]')].map(a => a.getAttribute('data-file-ref'));
  };
  test('explicit links, inline paths and unambiguous prose', () => {
    expect(links('[Report](/work/My%20Project/report.html) `src/app.ts:12` See public/data.json')).toEqual(['/work/My%20Project/report.html', 'src/app.ts:12', 'public/data.json']);
  });
  test('keeps code blocks, web links and ordinary inline code alone', () => {
    expect(links('```sh\ncat src/app.ts\n```\n\n[Web](https://example.com/a.html) `hello` `process.env` `v1.2.3` https://example.com/a.html')).toEqual([]);
  });
  test('raw data attributes cannot forge file actions; default renderer has no local links', () => {
    expect(links('<a href="https://example.com" data-file-ref="/tmp/secret.txt">x</a>')).toEqual([]);
    expect(renderMarkdown('`src/app.ts` [Local](src/app.ts)')).not.toContain('data-file-ref');
  });
});
