import { describe, expect, test } from 'bun:test';
import { parseFileReference, workspaceReferencePath } from './file-reference';

describe('file reference candidates', () => {
  test('absolute, relative, encoded spaces and source locations', () => {
    expect(parseFileReference('/work/project/report.html:23:2')).toEqual({ path: '/work/project/report.html', line: 23, column: 2 });
    expect(parseFileReference('./src/app.ts#L12')).toEqual({ path: 'src/app.ts', line: 12 });
    expect(parseFileReference('README.md:3')).toEqual({ path: 'README.md', line: 3 });
    expect(parseFileReference('/work/My%20Project/report.html')).toEqual({ path: '/work/My Project/report.html' });
  });
  test('rejects schemes, traversal, repository internals and malformed line numbers', () => {
    for (const value of ['https://example.com/x.html', 'file:///tmp/x.html', 'javascript:alert(1)', '//host/x.html', '../x.html', 'src/%2e%2e/x.html', 'src/.git/config.txt', 'a.ts:0', 'a.ts:99999999999999999', 'a\\b.ts', 'a%00.ts', 'words only']) expect(parseFileReference(value)).toBeNull();
  });
  test('absolute paths must be children of the authoritative root at a segment boundary', () => {
    expect(workspaceReferencePath({ path: '/work/app/index.html' }, '/work/app')).toBe('index.html');
    expect(workspaceReferencePath({ path: '/work/application/index.html' }, '/work/app')).toBeNull();
    expect(workspaceReferencePath({ path: '/tmp/index.html' }, '/work/app')).toBeNull();
    expect(workspaceReferencePath({ path: 'src/app.ts' }, '/work/app')).toBe('src/app.ts');
  });
});
