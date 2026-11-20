import { createOperationID } from "../operations";
import { ProtocolError } from "./errors";
import { isRecord } from "./session-message";

export type DesktopQuality = "balanced" | "detail" | "motion";
export type DesktopEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle" }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; code: string; modifiers: number }
  | { kind: "text"; text: string }
  | { kind: "release" };

export type DesktopObservation = { rtp_time: number; healthy: boolean; encode_ms?: number };

export function readDesktopObservation(reply: unknown): DesktopObservation | undefined {
  if (!isRecord(reply) || !("rtp_time" in reply)) return;
  const stamp = reply.rtp_time;
  if (typeof stamp !== "number" || !Number.isInteger(stamp) || stamp < 0 || stamp > 0xffffffff
    || typeof reply.healthy !== "boolean") throw new ProtocolError("bad_response");
  const encode = reply.encode_ms;
  return { rtp_time: stamp, healthy: reply.healthy,
    encode_ms: typeof encode === "number" && Number.isFinite(encode) && encode >= 0 ? encode : undefined };
}

type DesktopTransport = {
  kind: string;
  rpc(op: string, params: object, timeout: number): Promise<unknown>;
};

const closing = new WeakMap<DesktopTransport, Promise<unknown>>();

export function bindDesktop(current: () => DesktopTransport | null) {
  const transport = current();
  if (transport?.kind !== "p2p") throw new ProtocolError("p2p_required");
  const id = createOperationID();
  let sequence = 0;
  let opened = false, closed = false;
  const rpc = async (op: string, params: object, timeout: number) => {
    if (current() !== transport) throw new ProtocolError("disconnected");
    return transport.rpc(op, params, timeout);
  };
  return {
    async open(sdp: string, control: boolean, audio: boolean, quality: DesktopQuality) {
      const previous = closing.get(transport);
      if (previous) await previous;
      if (closed) throw new ProtocolError("disconnected");
      opened = true;
      const result = await rpc("DesktopOpen", { operation_id: id, sdp, control, audio, quality }, 65_000);
      if (!isRecord(result) || typeof result.sdp !== "string" || typeof result.display !== "string"
        || result.control !== control || result.audio !== audio) throw new ProtocolError("bad_response");
      return { sdp: result.sdp, display: result.display };
    },
    async ping(observe = false, keyframe = false): Promise<DesktopObservation | undefined | void> {
      const params = { desktop_id: id, ...(observe && { observe: true }), ...(observe && keyframe && { keyframe: true }) };
      return readDesktopObservation(await rpc("DesktopPing", params, 3000));
    },
    input(event: DesktopEvent) {
      sequence++;
      return rpc("DesktopInput", { desktop_id: id, sequence, operation_id: id + "_" + sequence, event }, 2000);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!opened) return;
      const done = rpc("DesktopClose", { desktop_id: id, operation_id: createOperationID() }, 5000);
      closing.set(transport, done);
      try { await done; } finally { if (closing.get(transport) === done) closing.delete(transport); }
    },
  };
}
export type DesktopRPC = ReturnType<typeof bindDesktop>;
