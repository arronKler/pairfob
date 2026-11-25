import { messageOf } from '../../lib/notices';
import { dataURL, PREVIEW_ORIGIN, type PreviewResource } from './preview-resources';

export type PreviewRead = (url: string) => Promise<PreviewResource>;
/** A local file the page names that could not be read: its workspace path, and why. */
export type NoteMissing = (path: string, reason: string) => void;

const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const encoded = (text: string, mime: string) => dataURL({ bytes: encoder.encode(text), mime });

/** The workspace path a virtual preview URL names, for telling the reader what did not load. */
export function missingPath(url: string): string {
  const path = new URL(url).pathname.slice(1);
  try { return decodeURIComponent(path); } catch { return path; }
}

/**
 * Packs a page's local references into data URLs. A file that cannot be read
 * is reported and its reference keeps pointing at the workspace, where it fails
 * as a missing file fails on a server: one absent favicon does not withhold the
 * whole page.
 */
export function previewPacker(read: PreviewRead, noteMissing: NoteMissing) {
  const imports: Record<string, string> = {};
  const modules = new Set<string>();
  const styles = new Set<string>();
  const attempt = async (url: string): Promise<PreviewResource | null> => {
    try { return await read(url); } catch (error) { noteMissing(missingPath(url), messageOf(error)); return null; }
  };
  const localURL = (value: string, from: string): string | null => {
    if (!value || value.startsWith('#') || /^(data:|blob:)/i.test(value)) return null;
    const url = new URL(value, from);
    return url.origin === PREVIEW_ORIGIN ? url.href : null;
  };
  const asset = async (value: string, from: string): Promise<string> => {
    const url = localURL(value, from);
    if (!url) return new URL(value, from).href;
    const resource = await attempt(url);
    return resource ? dataURL(resource) + (new URL(url).hash || '') : url;
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
          const sheet = await attempt(url);
          replacement = sheet ? `@import "${encoded(await css(decoder.decode(sheet.bytes), url), 'text/css')}"` : `@import "${url}"`;
          styles.delete(url);
        }
      } else replacement = match[0].startsWith('@import') ? `@import "${new URL(value, from).href}"` : `url("${await asset(value, from)}")`;
      text = text.slice(0, match.index) + replacement + text.slice(match.index! + match[0].length);
    }
    return text;
  };
  const moduleText = async (text: string, from: string): Promise<string> => {
    const { init, parse } = await import("es-module-lexer");
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
    const source = await attempt(url);
    // An unreadable module stays out of the import map: importing it fails in the page, as a 404 would.
    if (source) imports[url] = encoded(await moduleText(decoder.decode(source.bytes), url), 'text/javascript');
  };
  /** A stylesheet the page adds while it runs, packed like a static one. Its own absence is the caller's to report. */
  const style = async (url: string): Promise<PreviewResource> => ({
    bytes: encoder.encode(await css(decoder.decode((await read(url)).bytes), url)), mime: 'text/css',
  });
  return { imports, attempt, localURL, asset, css, moduleText, moduleFile, style };
}
