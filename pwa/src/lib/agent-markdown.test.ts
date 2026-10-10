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
    expect(links('[Report](/work/My%20Project/report.html) `src/app.ts:12` See public/data.json')).toEqual(['/work/My Project/report.html', 'src/app.ts:12', 'public/data.json']);
  });
  test('plain home and absolute directories, inline spaces and Markdown links', () => {
    expect(links('目录 ~/Project/github/pairfob 或 /Users/arron/Project/github/pairfob。')).toEqual(['~/Project/github/pairfob', '/Users/arron/Project/github/pairfob']);
    expect(links('`~/My Project/report.html:4` [目录](~/Project/github/pairfob)')).toEqual(['~/My Project/report.html:4', '~/Project/github/pairfob']);
    expect(links('https://example.com/path ftp://host/path /work/../secret README words and/or')).toEqual([]);
  });
  test('keeps code blocks, web links and ordinary inline code alone', () => {
    expect(links('```sh\ncat src/app.ts\n```\n\n[Web](https://example.com/a.html) `hello` `process.env` `v1.2.3` https://example.com/a.html')).toEqual([]);
  });
  test('file URIs and encoded prose paths open through Pairfob, not browser file navigation', () => {
    expect(links('[Report](file:///work/report.html) `file://localhost/work/report.html:4` See file:///work/My%20Project/report.html.')).toEqual([
      '/work/report.html', 'file://localhost/work/report.html:4', 'file:///work/My%20Project/report.html',
    ]);
    expect(links('See /work/My%20Project/report.html.')).toEqual(['/work/My%20Project/report.html']);
    expect(links('file://remote/work/report.html [Remote](file://remote/work/report.html)')).toEqual([]);
    expect(renderMarkdown('[Report](file:///work/report.html)', true)).toContain('href="#file"');
    expect(renderMarkdown('[Report](file:///work/report.html)')).not.toContain('href=');
  });
  test('ambiguous spaced prose never becomes partial file links', () => {
    expect(links('打开 /work/My Project/report.html')).toEqual([]);
    expect(links('打开 /work/My Long Project/report.html')).toEqual([]);
    expect(links('打开 docs/My Project/report.html')).toEqual([]);
    expect(links('打开 /work/report.v1 Final.html')).toEqual([]);
    expect(links('`/work/My Project/report.html` [报告](</work/My Project/report.html>)')).toEqual(['/work/My Project/report.html', '/work/My Project/report.html']);
    expect(links('目录 ~/Project/github/pairfob，或 /work/app。')).toEqual(['~/Project/github/pairfob', '/work/app']);
  });
  test('raw percent filenames and URL filenames are kept distinct', () => {
    expect(links('`/work/100%done/report.html` `/work/report%20draft.html` [报告](/work/report%2520draft.html)')).toEqual(['/work/100%done/report.html', '/work/report%20draft.html', '/work/report%20draft.html']);
  });
  test('duplicate text after a rejected candidate still uses its actual match position', () => {
    expect(links('bad:/work/report.html /work/report.html')).toEqual(['/work/report.html']);
  });
  test('raw data attributes cannot forge file actions; default renderer has no local links', () => {
    expect(links('<a href="https://example.com" data-file-ref="/tmp/secret.txt">x</a>')).toEqual([]);
    expect(renderMarkdown('`src/app.ts` [Local](src/app.ts)')).not.toContain('data-file-ref');
  });
});
