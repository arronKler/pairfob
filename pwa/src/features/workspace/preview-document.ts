import { init, parse } from 'es-module-lexer';
import { installPreviewFetch } from './preview-fetch';
import { dataURL, PREVIEW_ORIGIN, type PreviewResource } from './preview-resources';

export type PreviewRead = (url: string) => Promise<PreviewResource>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encoded = (text: string, mime: string) => dataURL({ bytes: encoder.encode(text), mime });
const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Package static dependencies in-browser; no source or assets go to the origin server. */
export async function preparePreviewDocument(source: string, base: string, read: PreviewRead, token = ''): Promise<string> {
  const doc = document.implementation.createHTMLDocument('');
  // This document has no browsing context: scripts and resources stay inactive.
  // Parsing in the html context preserves head/body attributes and their handlers.
  doc.documentElement.innerHTML = source;
  const htmlTag = source.match(/<html\b(?:[^"'>]|"[^"]*"|'[^']*')*>/i)?.[0];
  if (htmlTag) {
    const shell = new DOMParser().parseFromString(htmlTag + '</html>', 'text/html');
    for (const attr of shell.documentElement.attributes) doc.documentElement.setAttribute(attr.name, attr.value);
  }
  const imports: Record<string, string> = {};
  const modules = new Set<string>();
  const styles = new Set<string>();
  const localURL = (value: string, from: string): string | null => {
    if (!value || value.startsWith('#') || /^(data:|blob:)/i.test(value)) return null;
    const url = new URL(value, from);
    return url.origin === PREVIEW_ORIGIN ? url.href : null;
  };
  const asset = async (value: string, from: string) => {
    const url = localURL(value, from);
    return url ? dataURL(await read(url)) + (new URL(url).hash || '') : new URL(value, from).href;
  };
  const css = async (text: string, from: string): Promise<string> => {
    // CSS comments cannot declare dependencies. Keep quoted and unquoted url() values intact.
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = /@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?|url\(\s*(?:(["'])(.*?)\3|([^)'"\s]+))\s*\)/gi;
    const matches = [...text.matchAll(pattern)];
    for (const match of matches.reverse()) {
      const value = match[2] ?? match[4] ?? match[5];
      if (!value || value.startsWith('#')) continue;
      const url = localURL(value, from);
      let replacement: string;
      if (match[0].startsWith('@import') && url) {
        if (styles.has(url)) replacement = '@import "data:text/css,"';
        else {
          styles.add(url);
          replacement = `@import "${encoded(await css(decoder.decode((await read(url)).bytes), url), 'text/css')}"`;
          styles.delete(url);
        }
      } else replacement = match[0].startsWith('@import') ? `@import "${new URL(value, from).href}"` : `url("${await asset(value, from)}")`;
      text = text.slice(0, match.index) + replacement + text.slice(match.index! + match[0].length);
    }
    return text;
  };
  const moduleText = async (text: string, from: string): Promise<string> => {
    await init;
    const [refs] = parse(text);
    for (const ref of [...refs].reverse()) {
      if ((ref.type === 'dynamic' && ref.glob) || !ref.specifier || (!ref.specifier.startsWith('.') && !ref.specifier.startsWith('/'))) continue;
      const url = new URL(ref.specifier, from).href;
      if (new URL(url).origin !== PREVIEW_ORIGIN) continue;
      await moduleFile(url);
      text = text.slice(0, ref.start) + (ref.type === 'dynamic' ? JSON.stringify(url) : url) + text.slice(ref.end);
    }
    return text;
  };
  const moduleFile = async (url: string): Promise<void> => {
    if (modules.has(url)) return;
    modules.add(url); // Record before descending, so cyclic ES imports remain cyclic.
    const text = await moduleText(decoder.decode((await read(url)).bytes), url);
    imports[url] = encoded(text, 'text/javascript');
  };
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
        element.setAttribute('href', element.getAttribute('rel') === 'stylesheet'
          ? encoded(await css(decoder.decode((await read(url)).bytes), url), 'text/css') : await asset(href, base));
        element.removeAttribute('integrity');
      }
    }
    // Content URLs only. Anchors/forms retain browser navigation semantics and no host bridge.
    for (const attr of ['src', 'poster']) {
      const value = element.getAttribute(attr);
      if (value && localURL(value, base)) element.setAttribute(attr, await asset(value, base));
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
