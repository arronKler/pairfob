import { t } from '../../lib/i18n';
import { ProtocolError } from '../../lib/protocol/errors';
import { WorkspaceMediaLoader, type MediaContentCache, type MediaSession } from './media-loader';

export const PREVIEW_ORIGIN = 'https://pairfob-preview.invalid';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 128;
export type PreviewResource = { bytes: Uint8Array; mime: string };

/** Resolve virtual paths inside the daemon workspace. No host filesystem paths or encoded traversal. */
export function previewResourcePath(url: string): string {
  const target = new URL(url);
  if (target.origin !== PREVIEW_ORIGIN || target.username || target.password) throw new Error(t('preview.outside'));
  let path: string;
  try { path = decodeURIComponent(target.pathname.slice(1)); } catch { throw new Error(t('preview.outside')); }
  if (!path || /[\\\u0000-\u001f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')
   ) throw new Error(t('preview.outside'));
  return path;
}

const MIMES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain', csv: 'text/csv', mp3: 'audio/mpeg', mp4: 'video/mp4', wasm: 'application/wasm',
};

/** One serial reader per preview: bounded local-file capability, never a session RPC bridge. */
export class PreviewResources {
  readonly base: string;
  private loader = new WorkspaceMediaLoader();
  private cached = new Map<string, Promise<PreviewResource>>();
  private queue: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private stopped = false;
  /** The page's own directories, deepest first: `site/blog/`, `site/`. */
  private ancestors: string[];
  /** The directory a root-relative reference was last found under. */
  private site: string | null = null;

  constructor(private session: MediaSession, private pane: string, path: string, private current: () => boolean, private sharedCache?: MediaContentCache) {
    this.base = `${PREVIEW_ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const dirs = path.split('/').slice(0, -1);
    this.ancestors = dirs.map((_, i) => dirs.slice(0, dirs.length - i).join('/') + '/');
  }
  close(): void { this.stopped = true; this.cached.clear(); this.loader.release(); }
  private check(): void { if (this.stopped || !this.current()) throw new Error(t('preview.stale')); }

  /**
   * Where a path may live. A root-relative reference (`/assets/app.js`) names
   * the site's root, which for a built page is its own directory
   * (`dist/index.html`), not the workspace. A path above the page's top
   * directory is read as written first, then under the page's directories.
   * Paths inside the page's own tree resolved correctly and get no retries.
   */
  private candidates(path: string): string[] {
    const top = this.ancestors.at(-1);
    if (!top || path.startsWith(top)) return [path];
    const dirs = this.site ? [this.site, ...this.ancestors] : this.ancestors;
    return [...new Set([path, ...dirs.map(dir => dir + path)])];
  }

  /** The workspace file a link names. A root-relative link follows a site root already found by the page's resources. */
  linkPath(url: string, rooted: boolean): string {
    const target = new URL(url);
    if (target.pathname.endsWith('/')) target.pathname += 'index.html';
    const path = previewResourcePath(target.href);
    return rooted && this.site && this.candidates(path).length > 1 ? this.site + path : path;
  }

  read = (url: string): Promise<PreviewResource> => {
    this.check();
    const path = previewResourcePath(url);
    const hit = this.cached.get(path);
    if (hit) return hit;
    if (this.cached.size >= MAX_FILES) return Promise.reject(new Error(t('preview.limit')));
    const result = this.queue.then(async () => {
      let missing: unknown;
      for (const candidate of this.candidates(path)) {
        this.check();
        try {
          const loaded = await this.loader.load(this.session, this.pane, candidate, ({ total }) => {
            this.check();
            if (this.bytes + total > MAX_BYTES) throw new Error(t('preview.limit'));
          }, undefined, this.sharedCache);
          this.check();
          const bytes = new Uint8Array(await loaded.blob.arrayBuffer());
          this.check();
          this.bytes += bytes.length;
          if (candidate !== path) this.site = candidate.slice(0, -path.length);
          return { bytes, mime: MIMES[candidate.split('.').pop()?.toLowerCase() || ''] || loaded.open.mime };
        } catch (error) {
          // Only absence moves on to the next place; every other failure is the answer.
          if (!(error instanceof ProtocolError && error.code === 'workspace_not_found')) throw error;
          missing = error;
        } finally { this.loader.release(); }
      }
      throw missing;
    });
    this.cached.set(path, result);
    this.queue = result.catch(() => undefined);
    return result;
  };
}

export function dataURL(resource: PreviewResource): string {
  let binary = '';
  for (let offset = 0; offset < resource.bytes.length; offset += 8192) {
    binary += String.fromCharCode(...resource.bytes.subarray(offset, offset + 8192));
  }
  return `data:${resource.mime};base64,${btoa(binary)}`;
}
