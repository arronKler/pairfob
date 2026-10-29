import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls: any[] = [];
mock.module('node:child_process', () => ({
  execFile(binary: string, args: string[], options: unknown, done: Function) {
    expect(binary).toBe('/safe/pairfob');
    expect(args).toEqual(['agent-hook', 'cmd']);
    return { stdin: { on() {}, end(body: string) { calls.push(JSON.parse(body)); queueMicrotask(() => done()); } } };
  },
}));
const before = { ...process.env };
const directory = mkdtempSync(join(tmpdir(), 'pairfob-cmd-hook-'));
afterAll(() => { process.env = before; mock.restore(); rmSync(directory, { recursive: true, force: true }); });
const source = (await Bun.file(new URL('./command-code.js', import.meta.url)).text()).replace('PAIRFOB_BINARY', JSON.stringify('/safe/pairfob'));
const modulePath = join(directory, 'command-code.mjs');
writeFileSync(modulePath, source);
const { default: plugin } = await import(modulePath);
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('Command Code follows live branches, tools, session replacement and owner isolation', async () => {
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/private/herdr.sock', CMD_HERDR_PANE_OWNER: String(process.pid) });
  let hooks: any, poll: Function, leaf: string | null = 'prompt01';
  const events: Record<string, Function> = {};
  const api = { hooks(value: any) { hooks = value; }, on(name: string, fn: Function) { events[name] = fn; },
    sessions: { leafId: () => leaf }, clock: { every(ms: number, fn: Function) { poll = fn; } } };
  plugin(api);
  hooks.onSessionStart({ sessionId: 'session-one' }); await flush();
  events.tool_running({ toolName: 'shell', toolCallId: 'call-1', input: { secret: 'private' } }); await flush();
  expect(calls.at(-1).activity).toMatchObject({ type: 'tool', name: 'shell', state: '' });
  events.tool_errored({ toolName: 'shell', error: 'private output' }); await flush();
  expect(calls.at(-1).activity.state).toBe('error');
  events.run_end({}); leaf = null; poll!(); await flush();
  expect(calls.at(-1)).toMatchObject({ leaf: '', clear: false });
  expect(calls.at(-1).activity).toBeUndefined();
  hooks.onSessionEnd({ reason: 'replaced' }); await flush();
  expect(calls.at(-1).clear).toBe(true);
  hooks.onSessionStart({ sessionId: 'session-two' }); await flush();
  expect(calls.at(-1).session_id).toBe('session-two');
  expect(JSON.stringify(calls)).not.toContain('private');
  const count = calls.length;
  hooks.onSessionEnd({ reason: 'reload' }); await flush();
  expect(calls.length).toBe(count);
  expect(calls.every((value, i) => i === 0 || value.sequence > calls[i - 1].sequence)).toBe(true);
  process.env.CMD_HERDR_PANE_OWNER = 'another-process';
  plugin({ hooks() { throw new Error('child activated'); } });
});
