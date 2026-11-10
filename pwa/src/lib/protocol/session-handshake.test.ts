import { describe, expect, test } from "bun:test";
import { jsonFrame, Typ, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel, FrameChannelKind } from "./frame-channel.ts";
import type { PairResult } from "./pair-input.ts";
import { beginSessionEpoch } from "./session-handshake.ts";

const routeId = new Uint8Array(16).fill(2);
const pair = {
  deviceId: "dev_12345678",
  daemonId: "d_" + "a".repeat(20),
  psk: new Uint8Array(32).fill(9),
  daemonPk: new Uint8Array(32).fill(4),
  fp: "0000-0000-0000-0000",
  relayOrigin: "https://pairfob.test",
  label: "test",
  createdAt: 0,
} satisfies PairResult;

class HelloChannel implements FrameChannel {
  readonly kind: FrameChannelKind = "relay";
  readonly sent: Frame[] = [];
  private queued: Frame[] = [];
  private waiting: Array<(frame: Frame) => void> = [];

  send(frame: Frame): void { this.sent.push(frame); }
  close(): void {}
  use(): void {}
  onClose(): () => void { return () => undefined; }

  next(): Promise<Frame> {
    const frame = this.queued.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  deliver(frame: Frame): void {
    const resolve = this.waiting.shift();
    if (resolve) resolve(frame);
    else this.queued.push(frame);
  }
}

describe("DeviceHello rejection without an error code", () => {
  test("reports bad_message instead of burning the credential as unpaired", async () => {
    const channel = new HelloChannel();
    const hello = beginSessionEpoch(channel, routeId, pair, 2);
    channel.deliver(jsonFrame(Typ.FWD, routeId, { v: 1, op: "DeviceHello2", ok: false }));

    const error = await hello.verified.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("bad_message");
  });
});
