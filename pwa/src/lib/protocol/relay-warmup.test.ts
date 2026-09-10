import { afterEach, expect, test } from "bun:test";
import { RelayWarmup } from "./relay-warmup.ts";
const active: Array<{ stop(): void }> = [];
afterEach(() => { for (const server of active.splice(0)) server.stop(); });
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};
function fixture(delay = 0) {
  let opened = 0, closed = 0, messages = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    async fetch(req, server) {
      if (delay) await Bun.sleep(delay);
      if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "pairfob.v2" } })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: { open() { opened++; }, close() { closed++; }, message() { messages++; } },
  });
  active.push({ stop: () => server.stop(true) });
  const warmup = new RelayWarmup(`ws://127.0.0.1:${server.port}/v2/ws`);
  return { warmup, opened: () => opened, closed: () => closed, messages: () => messages };
}
test("preconnect sends no auth frames and transfers one socket exactly once", async () => {
  const f = fixture(); f.warmup.start(); f.warmup.start();
  const ready = await f.warmup.take();
  expect(ready).not.toBeNull(); expect(f.opened()).toBe(1); expect(f.messages()).toBe(0);
  expect(await f.warmup.take()).toBeNull();
  f.warmup.cancel();
  expect(ready!.socket.ws.readyState).toBe(WebSocket.OPEN);
  ready!.socket.close(); await waitFor(() => f.closed() === 1);
});
test("healthy recovery or hiding closes an unused prepared socket", async () => {
  const f = fixture(); f.warmup.start(); await waitFor(() => f.opened() === 1);
  f.warmup.cancel(); await waitFor(() => f.closed() === 1);
  expect(await f.warmup.take()).toBeNull(); expect(f.messages()).toBe(0);
});
test("offline during pending transfer aborts without leaking a socket", async () => {
  const f = fixture(100); f.warmup.start();
  const controller = new AbortController(); const pending = f.warmup.take(controller.signal);
  controller.abort(); expect(await pending).toBeNull();
  await Bun.sleep(120); expect(f.messages()).toBe(0); expect(f.opened()).toBe(f.closed());
});
test("already aborted reconnect cannot consume a ready socket", async () => {
  const f = fixture(); f.warmup.start(); await waitFor(() => f.opened() === 1);
  const controller = new AbortController(); controller.abort();
  expect(await f.warmup.take(controller.signal)).toBeNull(); await waitFor(() => f.closed() === 1);
});

test("cancelling before WebSocket open cannot publish a late prepared socket", async () => {
  const f = fixture(100); f.warmup.start(); f.warmup.cancel();
  await Bun.sleep(120);
  expect(await f.warmup.take()).toBeNull();
  expect(f.opened()).toBe(f.closed()); expect(f.messages()).toBe(0);
});
