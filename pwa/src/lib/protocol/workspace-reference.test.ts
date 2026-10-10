import { expect, test } from 'bun:test';
import { parseWorkspaceReference } from './workspace-reference';
import { scopeHerdSession } from './herd-sessions';

test('workspace references strictly preserve root, relative path and actual type', () => {
  const directory = { root: '/work/app', path: '', kind: 'directory' };
  expect(parseWorkspaceReference(directory)).toEqual(directory);
  expect(parseWorkspaceReference({ ...directory, path: 'no-extension', kind: 'file' }).path).toBe('no-extension');
  for (const value of [null, { ...directory, extra: 1 }, { ...directory, root: 'relative' }, { ...directory, path: '../x' }, { ...directory, path: '/x' }, { ...directory, path: '.git/config' }, { ...directory, kind: 'symlink' }, { ...directory, kind: 'file' }]) {
    expect(() => parseWorkspaceReference(value)).toThrow();
  }
  expect(scopeHerdSession('WorkspaceResolve', { pane_id: 'p1', root: '/work/app', path: '~/app' }, 'named')).toEqual({ pane_id: 'p1', root: '/work/app', path: '~/app', session: 'named' });
});
