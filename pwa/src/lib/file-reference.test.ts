import { describe, expect, test } from 'bun:test';
import { parseFileReference, workspaceReferencePath } from './file-reference';

describe('file reference candidates', () => {
  test('absolute, relative, encoded spaces and source locations', () => {
    expect(parseFileReference('/work/project/report.html:23:2')).toEqual({ path: '/work/project/report.html', line: 23, column: 2 });
    expect(parseFileReference('./src/app.ts#L12')).toEqual({ path: 'src/app.ts', line: 12 });
    expect(parseFileReference('README.md:3')).toEqual({ path: 'README.md', line: 3 });
    expect(parseFileReference('/work/My%20Project/report.html', 'url')).toEqual({ path: '/work/My Project/report.html' });
  });
  test('rejects schemes, traversal, repository internals and malformed line numbers', () => {
    for (const value of ['https://example.com/x.html', 'javascript:alert(1)', '//host/x.html', '../x.html', 'src/.git/config.txt', 'a.ts:0', 'a.ts:99999999999999999', 'a\\b.ts', 'words only']) expect(parseFileReference(value)).toBeNull();
  });
  test('local file URIs retain their absolute path and source location', () => {
    expect(parseFileReference('file:///work/My%20Project/report.html:23:2')).toEqual({ path: '/work/My Project/report.html', line: 23, column: 2 });
    expect(parseFileReference('file://localhost/work/report.html#L12')).toEqual({ path: '/work/report.html', line: 12 });
    expect(parseFileReference('file:/work/report.html')).toEqual({ path: '/work/report.html' });
    for (const value of ['file://remote/work/report.html', 'file://user@localhost/work/report.html', 'file:///work/../report.html', 'file:///work/%2e%2e/report.html', 'file:report.html', 'file:////remote/report.html']) expect(parseFileReference(value)).toBeNull();
  });
  test('absolute paths must be children of the authoritative root at a segment boundary', () => {
    expect(workspaceReferencePath({ path: '/work/app/index.html' }, '/work/app')).toBe('index.html');
    expect(workspaceReferencePath({ path: '/work/application/index.html' }, '/work/app')).toBeNull();
    expect(workspaceReferencePath({ path: '/tmp/index.html' }, '/work/app')).toBeNull();
    expect(workspaceReferencePath({ path: 'src/app.ts' }, '/work/app')).toBe('src/app.ts');
  });
});

test('rooted directory candidates, spaces and home paths stay distinct from cwd-relative files', () => {
  for (const path of ['~/Project/github/pairfob', '/Users/arron/Project/github/pairfob', '/work/My Project/report.html']) {
    expect(parseFileReference(path)).toEqual({ path });
  }
  expect(parseFileReference('~/Project/github/pairfob/')).toEqual({ path: '~/Project/github/pairfob' });
  expect(workspaceReferencePath({ path: '~/Project/report.html' }, '/work/app')).toBeNull();
  expect(workspaceReferencePath({ path: '/work/app' }, '/work/app')).toBe('');
  expect(workspaceReferencePath({ path: '/work/app/src' }, '/work/app')).toBe('src');
});


test('raw percent names stay literal; only URL references decode once', () => {
  expect(parseFileReference('/work/100%done/report.html')?.path).toBe('/work/100%done/report.html');
  expect(parseFileReference('/work/report%20draft.html')?.path).toBe('/work/report%20draft.html');
  expect(parseFileReference('/work/report%2520draft.html', 'url')?.path).toBe('/work/report%20draft.html');
  for (const input of ['src/%2e%2e/x.html', 'a%00.ts']) expect(parseFileReference(input, 'url')).toBeNull();
});
