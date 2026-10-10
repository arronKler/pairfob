// Runs in its OWN bun test process (spawned from
// src/lib/protocol/herd-session-wire.test.ts): like the upload-v2 harness it
// stubs process-global network/negotiation I/O with mock.module. The session,
// its RPC funnels and the AEAD transport stay production code; only the wire
// answers are scripted.
import { test, expect, mock } from "bun:test";
import { Wire } from "./media-wire-fixture";
import { fingerprint16 } from "../src/lib/protocol/hello";
import * as sockets from "../src/lib/protocol/frame-socket";
import * as handshake from "../src/lib/protocol/session-handshake";

let relay: Wire;

mock.module("../src/lib/protocol/frame-socket", () => ({ ...sockets, openWS: async () => relay as never }));
mock.module("../src/lib/protocol/session-handshake", () => ({
  ...handshake,
  establishSessionEpoch: async (channel: Wire) => channel.epoch(),
}));

const { sessionOverWS } = await import("../src/lib/protocol/session-ws") as {
  sessionOverWS(url: string, pair: object, opts: object): Promise<Live>;
};

type Live = {
  close(): void;
  getConfig(): Promise<Record<string, unknown>>;
  workspaceList(paneId: string, path: string, cursor: string, limit: number, root: string): Promise<unknown>;
  workspaceRead(paneId: string, path: string, root: string): Promise<unknown>;
  workspaceMediaOpen(paneId: string, path: string, root?: string, options?: { requireDirect: boolean }): Promise<unknown>;
  workspaceMediaRead(handle: string, offset: number, length: number, options?: { requireDirect: boolean }): Promise<unknown>;
  snapshot(): Promise<unknown>;
  paneRead(paneId: string): Promise<unknown>;
  sendText(paneId: string, text: string): Promise<unknown>;
  listDevices(): Promise<unknown>;
  terminalOpen(paneId: string, cols: number, rows: number): Promise<unknown>;
  terminalInput(terminalId: string, sequence: number, data: Uint8Array): Promise<unknown>;
  listHerdSessions(): Promise<{ name: string | null; running: boolean }[]>;
  herdSession(): string | null;
  selectHerdSession(name: string | null): void;
};

const pk = new Uint8Array(32).fill(3);
const pair = {
  daemonId: "d_" + "b".repeat(20), deviceId: "dev_12345678", daemonPk: pk, psk: new Uint8Array(32).fill(9),
  fp: fingerprint16(pk), relayOrigin: "https://pairfob.com",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextRequest(op: string, after = 0) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = relay.requests.filter((request) => request.op === op);
    if (found.length > after) return found[after];
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${op}`);
    await sleep(2);
  }
}

async function withSession(run: (live: Live) => Promise<void>) {
  relay = new Wire("relay", 1);
  const live = await sessionOverWS("wss://pairfob.com/v2/ws", pair as never, { p2p: false, networkMode: "relay" });
  try {
    await run(live);
  } finally {
    live.close();
    relay.close();
  }
}

test("the default session keeps the pre-switch wire byte-for-byte", () => withSession(async (live) => {
  expect(live.herdSession()).toBeNull();
  void live.getConfig().catch(() => undefined);
  void live.snapshot().catch(() => undefined);
  void live.paneRead("w1:p1").catch(() => undefined);
  expect((await nextRequest("GetConfig")).params).toEqual({});
  expect((await nextRequest("Snapshot")).params).toEqual({ session: null });
  expect("session" in (await nextRequest("PaneRead")).params).toBe(false);
}));

test("a selected session scopes exactly the ops whose schema accepts it", () => withSession(async (live) => {
  live.selectHerdSession("work");
  expect(live.herdSession()).toBe("work");
  void live.getConfig().catch(() => undefined);
  void live.snapshot().catch(() => undefined);
  void live.sendText("w1:p1", "hi").catch(() => undefined);
  void live.listDevices().catch(() => undefined);
  void live.terminalOpen("w1:p1", 80, 24).catch(() => undefined);
  void live.terminalInput("term_0123456789abcdef0123456789abcdef", 1, new Uint8Array([97])).catch(() => undefined);
  expect((await nextRequest("GetConfig")).params).toEqual({ session: "work" });
  expect((await nextRequest("Snapshot")).params).toEqual({ session: "work" });
  expect((await nextRequest("SendText")).params.session).toBe("work");
  expect((await nextRequest("TerminalOpen")).params.session).toBe("work");
  // Daemon-wide and handle-keyed ops must not carry it: the decoder is strict.
  expect("session" in (await nextRequest("ListDevices")).params).toBe(false);
  expect("session" in (await nextRequest("TerminalInput")).params).toBe(false);

  live.selectHerdSession(null);
  void live.snapshot().catch(() => undefined);
  expect((await nextRequest("Snapshot", 1)).params).toEqual({ session: null });
}));

test("a read keeps the session it was issued for even if the selection moves first", () => withSession(async (live) => {
  live.selectHerdSession("work");
  const pending = live.snapshot();
  live.selectHerdSession("other");
  const request = await nextRequest("Snapshot");
  expect(request.params).toEqual({ session: "work" });
  relay.reply(request, {});
  await pending;
}));

test("invalid names are refused without moving the selection", () => withSession(async (live) => {
  live.selectHerdSession("work");
  for (const bad of ["", ".", "..", "../x", "a b", "x".repeat(129)]) {
    expect(() => live.selectHerdSession(bad)).toThrow();
  }
  expect(live.herdSession()).toBe("work");
}));

test("ListSessions results are validated strictly", () => withSession(async (live) => {
  const good = live.listHerdSessions();
  relay.reply(await nextRequest("ListSessions"), { sessions: [{ name: null, running: false }, { name: "work", running: true }] });
  expect(await good).toEqual([{ name: null, running: false }, { name: "work", running: true }]);

  const bad: unknown[] = [
    { sessions: [] },
    { sessions: [{ name: "work", running: true }] },
    { sessions: [{ name: null, running: true }, { name: null, running: true }] },
    { sessions: [{ name: null, running: true }, { name: "../x", running: true }] },
    { sessions: [{ name: null, running: "yes" }] },
    { sessions: [{ name: null, running: true, extra: 1 }] },
    { sessions: [{ name: null, running: true }], extra: 1 },
  ];
  for (const [index, result] of bad.entries()) {
    const pending = live.listHerdSessions();
    relay.reply(await nextRequest("ListSessions", index + 1), result);
    await expect(pending).rejects.toThrow();
  }
}));


test("a media open keeps the Herdr session selected when issued", () => withSession(async (live) => {
  live.selectHerdSession("work");
  const pending = live.workspaceMediaOpen("w1:p1", "image.png");
  void pending.catch(() => undefined);
  live.selectHerdSession("other");
  const request = await nextRequest("WorkspaceMediaOpen");
  expect(request.params.session).toBe("work");
}));


test("root-bound readers preserve issue-time session and never downgrade on failure", () => withSession(async live => {
  live.selectHerdSession('work');
  const pending = [
    live.workspaceList('w1:p1', 'src', '', 120, '/original').catch(error => error),
    live.workspaceRead('w1:p1', 'src/app.ts', '/original').catch(error => error),
    live.workspaceMediaOpen('w1:p1', 'report.html', '/original').catch(error => error),
  ];
  live.selectHerdSession('other');
  for (const op of ['WorkspaceListAtRoot', 'WorkspaceReadAtRoot', 'WorkspaceMediaOpenAtRoot']) {
    const request = await nextRequest(op);
    expect(request.params.root).toBe('/original');
    expect(request.params.session).toBe('work');
    relay.reply(request, {}, false);
  }
  for (const result of await Promise.all(pending)) expect(result.code).toBe('conflict');
  expect(relay.requests.some(request => ['WorkspaceList', 'WorkspaceRead', 'WorkspaceMediaOpen'].includes(request.op))).toBe(false);
}));


test("HTML media cannot send Open or chunk reads over the real relay transport", () => withSession(async live => {
  const before = relay.requests.length;
  await expect(live.workspaceMediaOpen('w1:p1', 'report.html', '/original', { requireDirect: true })).rejects.toThrow('p2p_required');
  await expect(live.workspaceMediaRead('media_' + 'c'.repeat(32), 0, 65536, { requireDirect: true })).rejects.toThrow('p2p_required');
  expect(relay.requests.length).toBe(before);
}));
