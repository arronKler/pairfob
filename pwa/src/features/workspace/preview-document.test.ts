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
    const { html, missing } = await preparePreviewDocument('<html lang="zh" class="dark"><head><link rel="stylesheet" href="./main.css"></head><body class="report"><img src="./icon.svg"><script type="module" src="./a.js"></script><script src="https://cdn.example.com/lib.js"></script></body></html>', base, read({
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
    expect(missing.size).toBe(0);
  } finally { Object.assign(globalThis, { document: previous, DOMParser: parser }); }
});

async function withDOM<T>(run: () => Promise<T>): Promise<T> {
  const previous = globalThis.document;
  const parser = globalThis.DOMParser;
  Object.assign(globalThis, { document: window.document, DOMParser: window.DOMParser });
  try { return await run(); } finally { Object.assign(globalThis, { document: previous, DOMParser: parser }); }
}

test('an unreadable file is reported and leaves the rest of the page packed', () => withDOM(async () => {
  const { html, missing } = await preparePreviewDocument('<html><head><link rel="icon" href="favicon.ico"><link rel="stylesheet" href="gone.css"><link rel="stylesheet" href="main.css"></head>'
    + '<body><img src="lost.png"><script type="module" src="./entry.js"></script></body></html>', base, read({
    'reports/main.css': '@import "./absent.css"; body{background:url(./bg.png)}', 'reports/bg.png': 'png',
    'reports/entry.js': 'import "./nowhere.js"; document.title = "ran";',
  }, []));
  expect([...missing.keys()].sort()).toEqual(['reports/absent.css', 'reports/favicon.ico', 'reports/gone.css', 'reports/lost.png', 'reports/nowhere.js']);
  expect(missing.get('reports/lost.png')).toBeTruthy();
  const template = document.createElement('template'); template.innerHTML = html;
  const page = template.content;
  // The missing references still name the workspace, so the page sees ordinary load errors.
  expect(page.querySelector('img')!.getAttribute('src')).toBe(`${PREVIEW_ORIGIN}/reports/lost.png`);
  expect(page.querySelector('link[href="gone.css"]')).not.toBeNull();
  const sheet = atob(page.querySelectorAll('link[rel="stylesheet"]')[1].getAttribute('href')!.split(',')[1]);
  expect(sheet).toContain(`@import "${PREVIEW_ORIGIN}/reports/absent.css"`);
  expect(sheet).toContain('data:text/plain;base64,');
  const map = JSON.parse(page.querySelector('script[type="importmap"]')!.textContent!);
  expect(Object.keys(map.imports)).toEqual([`${PREVIEW_ORIGIN}/reports/entry.js`]);
}));

test('local frames are packed as their own documents, and SVG pictures and objects are inlined', () => withDOM(async () => {
  const calls: string[] = [];
  const { html, missing } = await preparePreviewDocument('<html><body><iframe src="parts/chart.html"></iframe>'
    + '<svg><image href="pic.svg"/><image xlink:href="old.svg"/><use href="sprite.svg#a"/></svg><object data="doc.svg"></object></body></html>', base, read({
    'reports/parts/chart.html': '<html><body><img src="../pic.svg"><script src="chart.js"></script></body></html>',
    'reports/parts/chart.js': 'draw()', 'reports/pic.svg': '<svg/>', 'reports/old.svg': '<svg/>', 'reports/doc.svg': '<svg/>',
  }, calls));
  expect(missing.size).toBe(0);
  expect(calls).not.toContain('reports/sprite.svg');
  const template = document.createElement('template'); template.innerHTML = html;
  const frame = template.content.querySelector('iframe')!;
  expect(frame.hasAttribute('src')).toBe(false);
  const inner = frame.getAttribute('srcdoc')!;
  expect(inner).toContain(`<base href="${PREVIEW_ORIGIN}/reports/parts/chart.html">`);
  expect(inner).toContain('data:text/plain;base64,');
  expect(inner).not.toContain('src="chart.js"');
  const images = template.content.querySelectorAll('image');
  expect(images[0].getAttribute('href')).toStartWith('data:');
  expect(images[1].getAttribute('xlink:href')).toStartWith('data:');
  expect(template.content.querySelector('use')!.getAttribute('href')).toBe('sprite.svg#a');
  expect(template.content.querySelector('object')!.getAttribute('data')).toStartWith('data:');
}));
