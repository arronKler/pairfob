import { expect, test } from 'bun:test';
import { PreviewResources } from './preview-resources';
import type { MediaSession } from './media-loader';
import { ProtocolError } from '../../lib/protocol/errors';

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

test('HTML and later local resources use the original root even before a cwd notification', async () => {
  const { rootBoundMedia } = await import('./root-bound-media');
  const { ProtocolError } = await import('../../lib/protocol/errors');
  const fake = fakeMedia();
  const roots: Array<string | undefined> = [];
  let liveRoot = '/original';
  const session: MediaSession = {
    ...fake.session,
    workspaceMediaOpen: async (pane, path, root) => {
      roots.push(root);
      if (root !== liveRoot) throw new ProtocolError('conflict');
      return fake.session.workspaceMediaOpen(pane, path);
    },
  };
  const resources = new PreviewResources(rootBoundMedia(session, '/original'), 'pane', 'report%20draft.html', () => true);
  await resources.read(resources.base);
  liveRoot = '/replacement';
  await expect(resources.read(new URL('./app.js', resources.base).href)).rejects.toThrow('conflict');
  expect(roots).toEqual(['/original', '/original']);
  expect(fake.opens).toEqual(['report%20draft.html']);
  resources.close();
});

function fileTree(paths: string[]) {
  const fake = fakeMedia();
  const tried: string[] = [];
  const session: MediaSession = {
    ...fake.session,
    async workspaceMediaOpen(pane, path, root) {
      tried.push(path);
      if (!paths.includes(path)) throw new ProtocolError('workspace_not_found');
      return fake.session.workspaceMediaOpen(pane, path, root);
    },
  };
  return { session, tried };
}

test('a root-relative reference from a built page is found under the page directory, and the site root is remembered', async () => {
  const tree = fileTree(['dist/index.html', 'dist/assets/app.js', 'dist/assets/app.css', 'dist/about.html']);
  const resources = new PreviewResources(tree.session, 'pane', 'dist/index.html', () => true);
  await resources.read(resources.base);
  await resources.read(new URL('/assets/app.js', resources.base).href);
  expect(tree.tried).toEqual(['dist/index.html', 'assets/app.js', 'dist/assets/app.js']);
  tree.tried.length = 0;
  await resources.read(new URL('/assets/app.css', resources.base).href);
  expect(tree.tried).toEqual(['assets/app.css', 'dist/assets/app.css']);
  expect(resources.linkPath(new URL('/about.html', resources.base).href, true)).toBe('dist/about.html');
  expect(resources.linkPath(new URL('../README.md', resources.base).href, false)).toBe('README.md');
  expect(resources.linkPath(new URL('./guide/', resources.base).href, false)).toBe('dist/guide/index.html');
  resources.close();
});

test('the workspace path wins when it exists, and paths inside the page tree are never retried', async () => {
  const tree = fileTree(['site/blog/post.html', 'css/main.css', 'site/css/site.css']);
  const resources = new PreviewResources(tree.session, 'pane', 'site/blog/post.html', () => true);
  await resources.read(new URL('/css/main.css', resources.base).href);
  await resources.read(new URL('/css/site.css', resources.base).href);
  expect(tree.tried).toEqual(['css/main.css', 'css/site.css', 'site/blog/css/site.css', 'site/css/site.css']);
  tree.tried.length = 0;
  await expect(resources.read(new URL('./img/a.png', resources.base).href)).rejects.toThrow();
  await expect(resources.read(new URL('../missing.css', resources.base).href)).rejects.toThrow();
  expect(tree.tried).toEqual(['site/blog/img/a.png', 'site/missing.css']);
  resources.close();
});

test('only absence moves on to another place; other failures answer at once', async () => {
  const fake = fakeMedia();
  const tried: string[] = [];
  const session: MediaSession = { ...fake.session, async workspaceMediaOpen(_pane, path) { tried.push(path); throw new ProtocolError('forbidden'); } };
  const resources = new PreviewResources(session, 'pane', 'dist/index.html', () => true);
  await expect(resources.read(new URL('/assets/app.js', resources.base).href)).rejects.toThrow('forbidden');
  expect(tried).toEqual(['assets/app.js']);
  resources.close();
});
