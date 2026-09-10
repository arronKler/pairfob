import { Direction, DIR_C, DIR_S } from "../src/lib/protocol/aead";
import { decode, Typ, jsonFrame, type Frame } from "../src/lib/protocol/envelope";
import { ProtocolError } from "../src/lib/protocol/errors";

// A minimal encrypted transport fixture: both relay and P2P Wires are real
// AEAD epochs the production SessionTransport drives. Negotiation I/O is stubbed
// in the test; the wire itself answers Ping and WorkspaceMediaClose.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class Wire {
  readonly route = new Uint8Array(16).fill(this.serial);
  readonly ckey = new Uint8Array(32).fill(this.serial + 10);
  readonly skey = new Uint8Array(32).fill(this.serial + 20);
  readonly recv = new Direction(this.ckey, DIR_C);
  readonly sendDirection = new Direction(this.skey, DIR_S);
  requests: { id: string; op: string; params: Record<string, unknown> }[] = [];
  closed = false;
  handler: ((frame: Frame) => void) | null = null;
  closeHandlers = new Set<(e: ProtocolError) => void>();
  seen = new Map<string, ReturnType<typeof deferred<unknown>>>();
  ws = { readyState: 1, send: (bytes: ArrayBuffer) => this.send(decode(new Uint8Array(bytes))), close: () => this.close() };

  constructor(readonly kind: "relay" | "p2p", readonly serial: number) {}

  epoch() {
    return { routeId: this.route, c2s: new Direction(this.ckey, DIR_C), s2c: new Direction(this.skey, DIR_S) };
  }

  next() { return Promise.resolve(jsonFrame(Typ.SESSION_BOUND, this.route, { v: 2 })); }
  use(handler: (f: Frame) => void) { this.handler = handler; }
  onClose(handler: (e: ProtocolError) => void) { this.closeHandlers.add(handler); return () => { this.closeHandlers.delete(handler); }; }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h(new ProtocolError("disconnected", "fixture wire closed"));
  }

  send(frame: Frame) {
    if (this.closed) throw new ProtocolError("disconnected", "fixture wire closed");
    if (frame.typ === Typ.PING) { queueMicrotask(() => this.handler?.({ ...frame, typ: Typ.PONG })); return; }
    if (frame.typ !== Typ.FWD) return;
    const req = JSON.parse(new TextDecoder().decode(this.recv.open(this.route, frame.payload))) as
      { id: string; op: string; params: Record<string, unknown> };
    this.requests.push(req);
    this.seen.get(req.op)?.resolve(req);
    if (req.op === "Ping") queueMicrotask(() => this.reply(req, { t: req.params.t_ms }));
    if (req.op === "WorkspaceMediaClose") queueMicrotask(() => this.reply(req, { handle: req.params.handle, closed: true }));
  }

  wait(op: string) {
    const old = this.requests.find((r) => r.op === op);
    if (old) return Promise.resolve(old);
    let d = this.seen.get(op);
    if (!d) { d = deferred<unknown>(); this.seen.set(op, d); }
    return d.promise;
  }

  reply(req: { id: string }, result: unknown, ok = true) {
    if (this.closed) return;
    const body = ok
      ? { v: 1, id: req.id, ok: true, result }
      : { v: 1, id: req.id, ok: false, error: { code: "conflict", message: "retired" } };
    this.handler?.({
      version: 1, typ: Typ.FWD, flags: 0, routeId: this.route,
      payload: this.sendDirection.seal(this.route, new TextEncoder().encode(JSON.stringify(body))),
    });
  }
}
