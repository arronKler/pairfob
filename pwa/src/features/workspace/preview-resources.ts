import { t } from '../../lib/i18n';
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

  constructor(private session: MediaSession, private pane: string, path: string, private current: () => boolean, private sharedCache?: MediaContentCache) {
    this.base = `${PREVIEW_ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  close(): void { this.stopped = true; this.cached.clear(); this.loader.release(); }
  private check(): void { if (this.stopped || !this.current()) throw new Error(t('preview.stale')); }
  read = (url: string): Promise<PreviewResource> => {
    this.check();
    const path = previewResourcePath(url);
    const hit = this.cached.get(path);
    if (hit) return hit;
    if (this.cached.size >= MAX_FILES) return Promise.reject(new Error(t('preview.limit')));
    const result = this.queue.then(async () => {
      this.check();
      try {
        const loaded = await this.loader.load(this.session, this.pane, path, ({ total }) => {
          this.check();
          if (this.bytes + total > MAX_BYTES) throw new Error(t('preview.limit'));
        }, undefined, this.sharedCache);
        this.check();
        const bytes = new Uint8Array(await loaded.blob.arrayBuffer());
        this.check();
        this.bytes += bytes.length;
        return { bytes, mime: MIMES[path.split('.').pop()?.toLowerCase() || ''] || loaded.open.mime };
      } finally { this.loader.release(); }
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
