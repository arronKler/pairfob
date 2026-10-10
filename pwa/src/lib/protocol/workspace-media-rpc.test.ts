import { expect, test } from 'bun:test';
import { WorkspaceMediaRPC } from './workspace-media-rpc';
import type { SessionTransport } from './session-transport';

function transport(kind: 'p2p' | 'relay') {
  const calls: Array<{ op: string; params: unknown }> = [];
  return { calls, wire: { kind, rpc: async (op: string, params: unknown) => {
    calls.push({ op, params }); throw new Error('wire reached');
  } } as unknown as SessionTransport };
}

test('preview policy rejects relay after an awaited transport switch, without sending', async () => {
  const relay = transport('relay');
  let release!: (value: SessionTransport) => void;
  const rpc = new WorkspaceMediaRPC(() => new Promise(resolve => { release = resolve; }), () => 'work');
  const pending = rpc.open('pane', 'report.html', '/root', { requireDirect: true });
  release(relay.wire);
  await expect(pending).rejects.toThrow('p2p_required');
  expect(relay.calls).toEqual([]);
});

test('each chunk rechecks the actual transport and ordinary media still supports relay', async () => {
  const direct = transport('p2p'), relay = transport('relay');
  let active = direct.wire;
  const rpc = new WorkspaceMediaRPC(async () => active, () => 'work');
  await expect(rpc.open('pane', 'report.html', '/root', { requireDirect: true })).rejects.toThrow('wire reached');
  expect(direct.calls[0]).toEqual({ op: 'WorkspaceMediaOpenAtRoot', params: { pane_id: 'pane', path: 'report.html', root: '/root', session: 'work' } });
  await expect(rpc.read('handle', 0, 65536, { requireDirect: true })).rejects.toThrow('wire reached');
  active = relay.wire;
  await expect(rpc.read('handle', 65536, 65536, { requireDirect: true })).rejects.toThrow('p2p_required');
  expect(relay.calls).toEqual([]);
  await expect(rpc.open('pane', 'photo.png')).rejects.toThrow('wire reached');
  await expect(rpc.read('handle', 0, 65536)).rejects.toThrow('wire reached');
  expect(relay.calls.map(c => c.op)).toEqual(['WorkspaceMediaOpen', 'WorkspaceMediaRead']);
});
