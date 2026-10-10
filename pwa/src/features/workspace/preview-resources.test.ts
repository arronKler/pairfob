import { expect, test } from 'bun:test';
import { PreviewResources } from './preview-resources';
import type { MediaSession } from './media-loader';

function fakeMedia() {
  const opens: string[] = [], closes: string[] = [];
  let size = 0;
  let corrupt = false;
  const session: MediaSession = {
    async workspaceMediaOpen(_pane, path) {
      opens.push(path);
      return { handle: path, path, kind: 'download', mime: 'application/octet-stream', size,
        sha256: corrupt ? '0'.repeat(64) : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        modified_ms: 1, expires_ms: 1, chunk_bytes: 65536, max_bytes: 33554432, max_pixels: 0, width: 0, height: 0 };
    },
    async workspaceMediaRead() { throw new Error('should fail before chunk read'); },
    async workspaceMediaClose(handle) { closes.push(handle); },
  };
  return { session, opens, closes, setSize(n: number) { size = n; }, corrupt() { corrupt = true; } };
}

test('preview cache shares reads and closes every remote handle', async () => {
  const fake = fakeMedia();
  const resources = new PreviewResources(fake.session, 'pane', 'reports/index.html', () => true);
  const a = resources.read(resources.base), b = resources.read(resources.base);
  expect(a).toBe(b);
  await a;
  expect(fake.opens).toEqual(['reports/index.html']);
  expect(fake.closes).toEqual(fake.opens);
  resources.close();
  expect(() => resources.read(resources.base)).toThrow();
});

test('a retired queued request makes no RPC under a replacement owner', async () => {
  const fake = fakeMedia();
  let current = true;
  const resources = new PreviewResources(fake.session, 'old-pane', 'index.html', () => current);
  const pending = resources.read(resources.base);
  current = false;
  await expect(pending).rejects.toThrow();
  expect(fake.opens).toEqual([]);
  resources.close();
});

test('oversize and tampered sources fail before a page can execute', async () => {
  for (const kind of ['oversize', 'digest']) {
    const fake = fakeMedia();
    if (kind === 'oversize') fake.setSize(33554433); else fake.corrupt();
    const resources = new PreviewResources(fake.session, 'pane', 'index.html', () => true);
    await expect(resources.read(resources.base)).rejects.toThrow();
    expect(fake.closes).toEqual(['index.html']);
    resources.close();
  }
});
