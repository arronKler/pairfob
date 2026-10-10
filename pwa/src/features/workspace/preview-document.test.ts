import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { preparePreviewDocument } from './preview-document';
import { PREVIEW_ORIGIN, previewResourcePath } from './preview-resources';

const window = new Window();
const base = `${PREVIEW_ORIGIN}/reports/index.html`;
const read = (files: Record<string, string>, calls: string[]) => async (url: string) => {
  const path = previewResourcePath(url);
  calls.push(path);
  if (!(path in files)) throw new Error('Missing ' + path);
  return { bytes: new TextEncoder().encode(files[path]), mime: path.endsWith('.js') ? 'text/javascript' : 'text/plain' };
};

test('preview workspace capability rejects traversal, foreign origins and encoded separators', () => {
  expect(previewResourcePath(`${PREVIEW_ORIGIN}/reports/data.json?x=1`)).toBe('reports/data.json');
  for (const url of ['https://example.com/data.json', `${PREVIEW_ORIGIN}/reports/%2e%2e%2fsecret.txt`, `${PREVIEW_ORIGIN}/reports/.git/config`, `${PREVIEW_ORIGIN}/reports/a%5cb.txt`]) expect(() => previewResourcePath(url)).toThrow();
});

test('packages styles, assets, cyclic modules and literal dynamic imports without reading external URLs', async () => {
  const previous = globalThis.document;
  const parser = globalThis.DOMParser;
  Object.assign(globalThis, { document: window.document, DOMParser: window.DOMParser });
  try {
    const calls: string[] = [];
    const html = await preparePreviewDocument('<html lang="zh" class="dark"><head><link rel="stylesheet" href="./main.css"></head><body class="report"><img src="./icon.svg"><script type="module" src="./a.js"></script><script src="https://cdn.example.com/lib.js"></script></body></html>', base, read({
      'reports/main.css': '@import "./colors.css";p{background:url(./icon.svg)}',
      'reports/colors.css': 'p{color:red}', 'reports/icon.svg': '<svg/>',
      'reports/a.js': 'import "./b.js"; export const a=1; import("./c.js");',
      'reports/b.js': 'import {a} from "./a.js"; export function value(){return a}',
      'reports/c.js': 'export default 3;',
    }, calls));
    expect(html).toContain('class="report"');
    expect(html).toContain('class="dark"');
    expect(html).toContain('data:text/css;base64,');
    expect(html).toContain('https://cdn.example.com/lib.js');
    const template = document.createElement('template'); template.innerHTML = html;
    const map = JSON.parse(template.content.querySelector('script[type="importmap"]')!.textContent!);
    expect(Object.keys(map.imports)).toHaveLength(3);
    const b = atob(map.imports[`${PREVIEW_ORIGIN}/reports/b.js`].split(',')[1]);
    expect(b).toContain(`${PREVIEW_ORIGIN}/reports/a.js`);
    expect(calls.every(path => path.startsWith('reports/'))).toBe(true);
  } finally { Object.assign(globalThis, { document: previous, DOMParser: parser }); }
});
