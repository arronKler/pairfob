import { expect, test } from "bun:test";
import { Direction, DIR_C, DIR_S } from "./aead";
import { Typ, type Frame } from "./envelope";
import type { FrameChannel } from "./frame-channel";
import { ProtocolError } from "./errors";
import { SessionTransport, type CarriedRequests } from "./session-transport";
import { AgentQuotaRPC } from "./agent-quota-rpc";

function fixture(carried?: CarriedRequests, keyByte = 7) {
  const key = new Uint8Array(32).fill(keyByte), route = new Uint8Array(16).fill(keyByte);
  let handler: (frame: Frame) => void = () => {};
  const sent: Frame[] = [];
  const channel: FrameChannel = {
    kind: "relay", send: frame => { sent.push(frame); }, close: () => {},
    next: async () => { throw new Error("unused"); }, use: next => { handler = next; }, onClose: () => () => {},
  };
  const inbound = new Direction(key, DIR_S), outbound = new Direction(key, DIR_C);
  const transport = new SessionTransport(channel, route, new Direction(key, DIR_C), new Direction(key, DIR_S), () => {}, [], carried);
  return {
    transport, sent,
    id: () => JSON.parse(new TextDecoder().decode(outbound.open(route, sent.at(-1)!.payload))).id as string,
    answer: (id: string, result: unknown, ok = true) => handler({ version: 1, typ: Typ.FWD, flags: 0, routeId: route,
      payload: inbound.seal(route, new TextEncoder().encode(JSON.stringify(ok
        ? { v:1, id, ok, result } : { v:1, id, ok, error:{code:"unpaired",message:"revoked"} }))) }),
  };
}

test("encrypted quota deltas retain their pending read across transport migration", async () => {
  const old = fixture();
  let updates = 0, settled = false;
  const read = old.transport.rpc("AgentQuotaStream", {}, 1_000, undefined, undefined, value => {
    if ((value as {done:boolean}).done) return false;
    updates++; return true;
  }).then(value => { settled = true; return value; });
  const id = old.id();
  old.answer(id,{items:[],done:false});
  await Promise.resolve();
  expect(updates).toBe(1); expect(settled).toBeFalse();
  const moved = fixture(old.transport.carryOut(),8);
  old.transport.close("transport_upgrade");
  moved.answer(id,{items:[],done:false});
  moved.answer(id,{items:[],done:true});
  expect(await read).toEqual({items:[],done:true});
  moved.answer(id,{items:[],done:false});
  expect(updates).toBe(2); expect(moved.sent.filter(frame => frame.typ === Typ.FWD)).toHaveLength(0);
  moved.transport.close();
});

test("interim data never renews the deadline and late deltas are ignored", async () => {
  const f = fixture(); let updates=0;
  const read=f.transport.rpc("AgentQuotaStream",{},60,undefined,undefined,()=>{updates++;return true;}).catch(e=>e);
  const id=f.id();
  const timer=setInterval(()=>f.answer(id,{done:false}),10);
  try {
    expect(await read).toMatchObject({code:"timeout"});
    const before=updates;
    f.answer(id,{done:false}); expect(updates).toBe(before);
  } finally { clearInterval(timer); f.transport.close(); }
});

test("error response settles a stream and malformed progress fails the epoch", async () => {
  const f=fixture();
  const read=f.transport.rpc("AgentQuotaStream",{},1_000,undefined,undefined,()=>true).catch(e=>e);
  f.answer(f.id(),null,false);
  expect(await read).toMatchObject({code:"unpaired"});
  const bad=f.transport.rpc("AgentQuotaStream",{},1_000,undefined,undefined,()=>{throw new ProtocolError("bad_message");}).catch(e=>e);
  f.answer(f.id(),{done:"bad"});
  expect(await bad).toMatchObject({code:"bad_message"});
  f.transport.close();
});

test("quota validation rejects malformed data without disrupting other session RPCs", async () => {
  const f = fixture();
  const quota = new AgentQuotaRPC().read((op, progress) =>
    f.transport.rpc(op, {}, 1_000, undefined, undefined, progress)).catch(error => error);
  f.answer(f.id(), { items: [{ provider: "codex" }], done: false });
  expect(await quota).toMatchObject({ code: "bad_frame" });
  const ping = f.transport.rpc("Ping", { t_ms: 1 });
  f.answer(f.id(), { t_ms: 1 });
  expect(await ping).toEqual({ t_ms: 1 });
  f.transport.close();
});
