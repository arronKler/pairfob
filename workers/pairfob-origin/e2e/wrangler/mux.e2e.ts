/// <reference types="@cloudflare/vitest-pool-workers" />
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { decode, encode, ENVELOPE_VERSION, Typ } from "../../src/envelope.ts";
import { encodeJSON } from "../../src/frames.ts";
import { ZERO_ROUTE } from "../../src/crypto.ts";

const ORIGIN = "https://pairfob.com";
const PAIR_REF = "4f7a2c9e1b0d88aa55cc3311abde7001";

type D1Migrations = Parameters<typeof applyD1Migrations>[1];

declare module "vitest" {
  export interface ProvidedContext {
    migrations: D1Migrations;
  }
}

beforeAll(() => applyD1Migrations(env.DB, inject("migrations")));

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function enroll(): Promise<{ daemon_id: string; reconnect_token: string }> {
  const daemonID = `d_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const reconnectToken = `rt_${crypto.randomUUID().replaceAll("-", "")}`;
  const res = await SELF.fetch(`${ORIGIN}/v2/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      v: 2,
      daemon_id: daemonID,
      reconnect_token: reconnectToken,
    }),
  });
  const body = await json(res);
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.daemon_id).toBe(daemonID);
  expect(body.reconnect_token).toBe(reconnectToken);
  return { daemon_id: String(body.daemon_id), reconnect_token: String(body.reconnect_token) };
}

async function openMux(path: string, origin?: string): Promise<{ ws: WebSocket; status: number }> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "pairfob.v2",
  };
  if (origin !== undefined) headers.Origin = origin;
  const res = await SELF.fetch(`${ORIGIN}${path}`, { headers });
  if (res.status === 101 && res.webSocket) {
    res.webSocket.accept();
    res.webSocket.binaryType = "arraybuffer";
    return { ws: res.webSocket, status: 101 };
  }
  return { ws: undefined as unknown as WebSocket, status: res.status };
}

function sendJSON(ws: WebSocket, typ: number, obj: unknown, routeId = ZERO_ROUTE): void {
  ws.send(encodeJSON(typ, routeId, obj));
}

async function toBytes(raw: unknown): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (typeof Blob !== "undefined" && raw instanceof Blob) return new Uint8Array(await raw.arrayBuffer());
  throw new Error(`websocket message was not bytes: ${Object.prototype.toString.call(raw)}`);
}

function nextFrame(ws: WebSocket, timeoutMs = 8_000): Promise<ReturnType<typeof decode>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      void toBytes(event.data)
        .then((bytes) => resolve(decode(bytes)))
        .catch(reject);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function readJSONFrame(ws: WebSocket, typ: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 8; i++) {
    const frame = await nextFrame(ws);
    if (frame.typ === Typ.PING) {
      ws.send(encode({ version: ENVELOPE_VERSION, typ: Typ.PONG, flags: 0, routeId: frame.routeId, payload: frame.payload }));
      continue;
    }
    if (frame.typ === Typ.PONG) continue;
    expect(frame.typ).toBe(typ);
    return JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
  }
  throw new Error("no JSON frame");
}

describe("wrangler enroll + HELLO + pairing ticket", () => {
  it("enrolls, acks PAIR_OPEN loc, consumes ticket once, QR has no ticket", async () => {
    const creds = await enroll();

    const daemon = await openMux(`/v2/ws?role=daemon&daemon_id=${creds.daemon_id}`);
    expect(daemon.status).toBe(101);
    sendJSON(daemon.ws, Typ.HELLO_DAEMON, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: creds.daemon_id,
      reconnect_token: creds.reconnect_token,
    });
    const hello = await readJSONFrame(daemon.ws, Typ.HELLO_DAEMON);
    expect(hello.ok).toBe(true);
    expect(hello.daemon_id).toBe(creds.daemon_id);
    expect(hello.reconnect_token).toBe(creds.reconnect_token);

    sendJSON(daemon.ws, Typ.PAIR_OPEN, {
      v: 2,
      op: "CreatePairing",
      daemon_id: creds.daemon_id,
      pair_ref: PAIR_REF,
      ttl_s: 180,
    });
    const ack = await readJSONFrame(daemon.ws, Typ.PAIR_OPEN);
    expect(ack.ok).toBe(true);
    expect(ack.pair_ref).toBe(PAIR_REF);
    const loc = String(ack.pair_loc || "");
    expect(loc).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{6}$/);

    const intent = await SELF.fetch(`${ORIGIN}/v2/pair-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ v: 2, pair_loc: loc }),
    });
    expect(intent.status).toBe(200);
    const hit = await json(intent);
    const ticket = String(hit.pair_ticket || "");
    expect(ticket).toMatch(/^[0-9a-f]{32}$/);
    expect(hit.daemon_id).toBe(creds.daemon_id);

    const first = await openMux(
      `/v2/ws?role=client&daemon_id=${creds.daemon_id}&pair_ticket=${ticket}`,
      ORIGIN,
    );
    expect(first.status).toBe(101);

    const second = await SELF.fetch(
      `${ORIGIN}/v2/ws?role=client&daemon_id=${creds.daemon_id}&pair_ticket=${ticket}`,
      { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "pairfob.v2", Origin: ORIGIN } },
    );
    expect(second.status).toBe(404);
    expect(await json(second)).toEqual({ ok: false, error: { code: "unpaired" } });

    const qr = await openMux(`/v2/ws?role=client&daemon_id=${creds.daemon_id}`, ORIGIN);
    expect(qr.status).toBe(101);
    sendJSON(qr.ws, Typ.HELLO_CLIENT, { v: 2, protocol: 2 });
    sendJSON(qr.ws, Typ.PAIR_ATTACH, { v: 2, pair_ref: PAIR_REF });
    const attached = await readJSONFrame(qr.ws, Typ.PAIR_ATTACHED);
    expect(attached.daemon_id).toBe(creds.daemon_id);

    const stats = await SELF.fetch(`${ORIGIN}/v2/admin/stats`, {
      headers: { Authorization: "Bearer dev-operator" },
    });
    expect(stats.status).toBe(200);
    const body = await json(stats);
    expect(typeof body.sampled_ws).toBe("number");
    expect((body.sampled_ws as number) >= 2).toBe(true);
  }, 20_000);
});
