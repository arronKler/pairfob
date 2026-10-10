import { ProtocolError } from './errors';
import { exactKeys, isRecord } from './session-message';

export type WorkspaceReference = { root: string; path: string; kind: 'file' | 'directory' };

export function parseWorkspaceReference(value: unknown): WorkspaceReference {
  const safe = (text: unknown): text is string => typeof text === 'string' && text.length <= 4096 && !/[\u0000-\u001f\u007f\\]/.test(text);
  if (!isRecord(value) || !exactKeys(value, ['root', 'path', 'kind'])
    || !safe(value.root) || !value.root.startsWith('/') || value.root.startsWith('//')
    || !safe(value.path) || value.path.startsWith('/')
    || (value.path !== '' && value.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))
    || (value.kind !== 'file' && value.kind !== 'directory') || (value.kind === 'file' && !value.path)) {
    throw new ProtocolError('bad_message', 'Invalid workspace reference');
  }
  return { root: value.root, path: value.path, kind: value.kind };
}
