import { expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { PreviewCache } from './preview-cache';
import { PreviewResources } from './preview-resources';
import { previewMedia } from './preview-media';
import type { MediaSession } from './media-loader';

function fixture() {
  let value = 'first';
  let forbidden = false, corrupt = false, direct = true;
  let opens = 0, reads = 0, closes = 0;
  const session: MediaSession = {
    async workspaceMediaOpen(_pane, path, _root, options) {
      opens++;
      if (forbidden) throw new Error('forbidden');
      if (options?.requireDirect && !direct) throw new Error('p2p_required');
      const bytes = new TextEncoder().encode(value);
      return { handle: 'handle', path, kind: 'download', mime: 'text/plain', size: bytes.length,
        sha256: corrupt ? '0'.repeat(64) : bytesToHex(sha256(bytes)), modified_ms: 1, expires_ms: 1,
        chunk_bytes: 65536, max_bytes: 33554432, max_pixels: 0, width: 0, height: 0 };
    },
    async workspaceMediaRead(handle, offset, _length, options) {
      reads++;
      if (options?.requireDirect && !direct) throw new Error('p2p_required');
      const bytes = new TextEncoder().encode(value);
      return { handle, offset, length: bytes.length, bytes, eof: true };
    },
    async workspaceMediaClose() { closes++; },
  };
  const cache = new PreviewCache(100, 3);
  async function read(path = 'report.html', owner: object = session, runtime: string | null = null, root = '/root', pane = 'pane') {
    const resources = new PreviewResources(previewMedia(session, root), pane, path, () => true, cache.scope(owner, runtime, root, pane));
    try { return new TextDecoder().decode((await resources.read(resources.base)).bytes); }
    finally { resources.close(); }
  }
  return { session, read, counts: () => ({ opens, reads, closes }),
    content: (next: string) => { value = next; }, deny: () => { forbidden = true; },
    corrupt: (next: boolean) => { corrupt = next; }, relay: () => { direct = false; } };
}

test('reopening checks SHA-256 but skips every chunk for unchanged HTML and dependencies', async () => {
  const f = fixture();
  for (const path of ['report.html', 'app.js', 'style.css']) expect(await f.read(path)).toBe('first');
  expect(f.counts()).toEqual({ opens: 3, reads: 3, closes: 3 });
  for (const path of ['report.html', 'app.js', 'style.css']) expect(await f.read(path)).toBe('first');
  expect(f.counts()).toEqual({ opens: 6, reads: 3, closes: 6 });
});

test('same-size and same-mtime edits still replace the cached version', async () => {
  const f = fixture();
  await f.read(); f.content('other');
  expect(await f.read()).toBe('other');
  await f.read();
  expect(f.counts()).toEqual({ opens: 3, reads: 2, closes: 3 });
});

test('failed authorization and relay fallback cannot expose cached content', async () => {
  for (const failure of ['deny', 'relay'] as const) {
    const f = fixture(); await f.read(); f[failure]();
    await expect(f.read()).rejects.toThrow(failure === 'deny' ? 'forbidden' : 'p2p_required');
    expect(f.counts()).toEqual({ opens: 2, reads: 1, closes: 1 });
  }
});

test('cache ownership separates computers, Herdr sessions, roots and panes', async () => {
  const f = fixture(); await f.read();
  await f.read('report.html', {}, null);
  await f.read('report.html', f.session, 'other');
  await f.read('report.html', f.session, null, '/other');
  await f.read('report.html', f.session, null, '/root', 'other');
  expect(f.counts().reads).toBe(5);
});

test('corrupt downloads are never cached and every admitted handle is closed', async () => {
  const f = fixture(); f.corrupt(true);
  await expect(f.read()).rejects.toThrow('digest');
  await expect(f.read()).rejects.toThrow('digest');
  f.corrupt(false); await f.read(); await f.read();
  expect(f.counts()).toEqual({ opens: 4, reads: 3, closes: 4 });
});

test('LRU evicts old entries by file count and total bytes', async () => {
  const f = fixture();
  for (const path of ['a.js', 'b.js', 'c.js']) await f.read(path);
  await f.read('a.js'); await f.read('d.js');
  await f.read('a.js');
  expect(f.counts().reads).toBe(4);
  await f.read('b.js'); expect(f.counts().reads).toBe(5);
  f.content('x'.repeat(60)); await f.read('large-a.js'); await f.read('large-b.js');
  await f.read('large-a.js'); expect(f.counts().reads).toBe(8);
});

test('a file larger than the shared cache budget is still readable but not retained', async () => {
  const f = fixture(); f.content('x'.repeat(101));
  await f.read(); await f.read(); expect(f.counts().reads).toBe(2);
});
