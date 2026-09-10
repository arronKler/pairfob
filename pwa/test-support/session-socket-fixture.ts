/** In-memory daemon peer with real DeviceHello and AEAD; close events are deliberately withheld. */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { Direction, DIR_C, DIR_S } from "../src/lib/protocol/aead";
import { b64url, b64urlDecode, bytesToHex } from "../src/lib/protocol/bytes";
import { decode, encode, jsonFrame, parseJSON, Typ, type Frame } from "../src/lib/protocol/envelope";
import { fingerprint16, proof, transcriptD, transcriptP } from "../src/lib/protocol/hello";
import { sessionKeys } from "../src/lib/protocol/kdf";
import type { PairResult } from "../src/lib/protocol/pair-ws";

export type HoldStage = "bound" | "hello" | "established" | "ping" | "none";
const secret = new Uint8Array(32).fill(7);
const pk = ed25519.getPublicKey(secret);
export const socketPair = {
  daemonId: "d_" + "a".repeat(20), deviceId: "dev_12345678", daemonPk: pk,
  psk: new Uint8Array(32).fill(9), fp: fingerprint16(pk), relayOrigin: "https://pairfob.test",
} as PairResult;

export class SessionSocket extends EventTarget {
  static OPEN = 1;
  static hold: HoldStage = "none";
  static instances: SessionSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  protocol = "pairfob.v2";
  blocked: HoldStage | null = null;
  frames: Frame[] = [];
  operations: string[] = [];
  closeCalls = 0;
  private route = new Uint8Array(16).fill(2);
  private eph = new Uint8Array(32).fill(3);
  private recv!: Direction;
  private out!: Direction;
  private transcript!: Uint8Array;
  private established = false;
  private held: Frame | null = null;
  private hold = SessionSocket.hold;
  constructor(_url?: string, _protocols?: string[]) {
    super(); SessionSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close(): void { this.closeCalls++; this.readyState = 2; }
  finishClose(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  reject(code: string): void { this.deliver(jsonFrame(Typ.ERROR, this.route, { code, message: code })); }
  releaseLate(): void { if (this.held) this.deliver(this.held); }
  private deliver(frame: Frame): void {
    const event = new Event("message");
    Object.assign(event, { data: encode(frame).buffer });
    this.dispatchEvent(event);
  }
  private reply(stage: HoldStage, frame: Frame): void {
    if (this.hold !== "none" && stage === this.hold) { this.blocked = stage; this.held = frame; return; }
    queueMicrotask(() => this.deliver(frame));
  }
  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("send on closing socket");
    const frame = decode(new Uint8Array(data)); this.frames.push(frame);
    if (frame.typ === Typ.SESSION_ATTACH) this.reply("bound", jsonFrame(Typ.SESSION_BOUND, this.route, { v: 2 }));
    if (frame.typ === Typ.PING) this.reply("none", { ...frame, typ: Typ.PONG });
    if (frame.typ !== Typ.FWD) return;
    if (this.established) {
      const req = JSON.parse(new TextDecoder().decode(this.recv.open(this.route, frame.payload)));
      this.operations.push(req.op);
      const payload = this.out.seal(this.route, new TextEncoder().encode(JSON.stringify({ v: 1, id: req.id, ok: true, result: { t_ms: req.params.t_ms } })));
      this.reply("ping", { ...frame, payload }); return;
    }
    const body = parseJSON(frame);
    if (body.op === "DeviceHello1") {
      const ephP = b64urlDecode(body.eph_x25519);
      this.transcript = transcriptD(socketPair.daemonId, socketPair.deviceId, ephP, x25519.getPublicKey(this.eph), b64urlDecode(body.nonce), 1n, this.route);
      const keys = sessionKeys(x25519.getSharedSecret(this.eph, ephP), socketPair.psk);
      this.recv = new Direction(keys.c2s, DIR_C); this.out = new Direction(keys.s2c, DIR_S);
      this.reply("hello", jsonFrame(Typ.FWD, this.route, { v: 1, op: "DeviceHello2", ok: true, ts: 1,
        eph_x25519: b64url(x25519.getPublicKey(this.eph)), proof_d: b64url(proof(socketPair.psk, this.transcript)), sig_d: b64url(ed25519.sign(this.transcript, secret)),
      }));
    } else if (body.op === "DeviceHello3") {
      if (body.proof_p !== b64url(proof(socketPair.psk, transcriptP(this.transcript)))) throw new Error("invalid phone proof");
      this.established = true;
      this.reply("established", jsonFrame(Typ.SESSION_ESTABLISHED, this.route, { v: 2, route_id: bytesToHex(this.route) }));
    }
  }
}
