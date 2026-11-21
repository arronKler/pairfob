import { installPreviewFetch } from './preview-fetch';
import { decoder, encoded, previewPacker, type NoteMissing, type PreviewRead } from './preview-packer';

export type { PreviewRead } from './preview-packer';
/** The packed page, and the local files it names that could not be read, by workspace path. */
export type PreviewPage = { html: string; missing: Map<string, string> };
const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const XLINK = 'http://www.w3.org/1999/xlink';
/** A local page inside a local page is packed too, this deep. */
const FRAME_DEPTH = 2;

/** Package static dependencies in-browser; no source or assets go to the origin server. */
export async function preparePreviewDocument(source: string, base: string, read: PreviewRead, token = ''): Promise<PreviewPage> {
  const missing = new Map<string, string>();
  const html = await packDocument(source, base, read, token, (path, reason) => { if (!missing.has(path)) missing.set(path, reason); }, 0);
  return { html, missing };
}

async function packDocument(source: string, base: string, read: PreviewRead, token: string, noteMissing: NoteMissing, depth: number): Promise<string> {
  const doc = document.implementation.createHTMLDocument('');
  // This document has no browsing context: scripts and resources stay inactive.
  // Parsing in the html context preserves head/body attributes and their handlers.
  doc.documentElement.innerHTML = source;
  const htmlTag = source.match(/<html\b(?:[^"'>]|"[^"]*"|'[^']*')*>/i)?.[0];
  if (htmlTag) {
    const shell = new DOMParser().parseFromString(htmlTag + '</html>', 'text/html');
    for (const attr of shell.documentElement.attributes) doc.documentElement.setAttribute(attr.name, attr.value);
  }
  const { imports, attempt, localURL, asset, css, moduleText, moduleFile } = previewPacker(read, noteMissing);
  for (const element of doc.documentElement.querySelectorAll('*')) {
    const tag = element.tagName;
    if (tag === 'BASE') { element.remove(); continue; }
    if (tag === 'META' && /^(refresh|content-security-policy)$/i.test(element.getAttribute('http-equiv') || '')) { element.remove(); continue; }
    if (element.hasAttribute('style')) element.setAttribute('style', await css(element.getAttribute('style')!, base));
    if (tag === 'STYLE') element.textContent = await css(element.textContent || '', base);
    if (tag === 'SCRIPT') {
      const src = element.getAttribute('src');
      const module = element.getAttribute('type') === 'module';
      if (src && localURL(src, base)) {
        const url = new URL(src, base).href;
        if (module) { await moduleFile(url); element.removeAttribute('src'); element.textContent = `import ${JSON.stringify(url)};`; }
        else element.setAttribute('src', await asset(src, base));
        element.removeAttribute('integrity');
      } else if (!src && module) element.textContent = await moduleText(element.textContent || '', base);
      continue;
    }
    if (tag === 'LINK' && element.getAttribute('href')) {
      const href = element.getAttribute('href')!;
      const url = localURL(href, base);
      if (url) {
        if (/\bstylesheet\b/i.test(element.getAttribute('rel') || '')) {
          const sheet = await attempt(url);
          if (sheet) element.setAttribute('href', encoded(await css(decoder.decode(sheet.bytes), url), 'text/css'));
        } else element.setAttribute('href', await asset(href, base));
        element.removeAttribute('integrity');
      }
    }
    // A local page in a frame is packed as its own document, so its references resolve against itself.
    if (tag === 'IFRAME' && depth < FRAME_DEPTH) {
      const src = element.getAttribute('src');
      const url = src ? localURL(src, base) : null;
      if (url && /\.html?$/i.test(new URL(url).pathname)) {
        const page = await attempt(url);
        if (page) {
          element.setAttribute('srcdoc', await packDocument(decoder.decode(page.bytes), url, read, token, noteMissing, depth + 1));
          element.removeAttribute('src');
        }
      }
    }
    // Content URLs only. Anchors/forms retain browser navigation semantics and no host bridge.
    for (const attr of ['src', 'poster']) {
      const value = element.getAttribute(attr);
      if (value && localURL(value, base)) element.setAttribute(attr, await asset(value, base));
    }
    if (tag === 'OBJECT') {
      const data = element.getAttribute('data');
      if (data && localURL(data, base)) element.setAttribute('data', await asset(data, base));
    }
    // SVG pictures; <use> is left alone, since browsers refuse data: URLs there.
    if (tag === 'image' || tag === 'feImage') {
      for (const [ns, name] of [[null, 'href'], [XLINK, 'href']] as const) {
        const value = element.getAttributeNS(ns, name);
        if (value && localURL(value, base)) element.setAttributeNS(ns, ns ? 'xlink:href' : 'href', await asset(value, base));
      }
    }
    const srcset = element.getAttribute('srcset');
    if (srcset && !srcset.includes('data:')) {
      const candidates = [];
      for (const candidate of srcset.split(',')) {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        candidates.push([await asset(url, base), ...descriptor].join(' '));
      }
      element.setAttribute('srcset', candidates.join(', '));
    }
    if (tag === 'A') { element.setAttribute('rel', 'noopener noreferrer'); if (/^https?:/i.test(element.getAttribute('href') || '')) element.setAttribute('target', '_blank'); }
  }
  // Bootstrap precedes all user code; it never executes in the host document.
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base.replace(/"/g, '%22')}">`
    + `<script>(${installPreviewFetch.toString()})(${scriptJSON(base)},${scriptJSON(token)})</script>`
    + `<script type="importmap">${scriptJSON({ imports })}</script>`;
  const bootstrap = document.createElement('template');
  bootstrap.innerHTML = head;
  doc.head.prepend(bootstrap.content);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
