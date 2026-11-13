/** Manual native-browser P2P phase profiling; run on an otherwise idle page. */
import { ProtocolError } from "../src/lib/protocol/errors.ts";
import type { PairResult } from "../src/lib/protocol/pair-ws.ts";
import { SessionTransport } from "../src/lib/protocol/session-transport.ts";
import type { LiveSession } from "../src/lib/protocol/session-types.ts";
import { sessionOverWS, type P2PAttemptObservation } from "../src/lib/protocol/session-ws.ts";

type Phase = { stage: string; ms: number };
export type UpgradeSample = {
  ok: boolean;
  result: string;
  marks: Phase[];
  peers: number;
  sockets: number;
  relay_client_frames: number;
};
let profiling = false;

/** Observe native APIs only; no fake timers, network delays, or payload logs.
 * The own-origin check preserves the relay's normal browser origin policy.
 * A dedicated temporary device avoids replacing another live user's route.
 */
export async function profileUpgrade(pair: PairResult): Promise<UpgradeSample> {
  if (profiling) throw new Error("Run upgrade samples serially");
  if (new URL(pair.relayOrigin).origin !== location.origin) throw new Error("Use the paired relay's origin");
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is unavailable");
  profiling = true;
  const NativePeer = RTCPeerConnection, NativeSocket = WebSocket, rpc = SessionTransport.prototype.rpc;
  const started = performance.now(), marks: Phase[] = [];
  const mark = (stage: string) => { marks.push({ stage, ms: performance.now() - started }); };
  let peers = 0, sockets = 0, relay_client_frames = 0, session: LiveSession | undefined;
  let finish!: (result: P2PAttemptObservation | { result: "timeout" }) => void;
  const finished = new Promise<P2PAttemptObservation | { result: "timeout" }>(resolve => { finish = resolve; });
  const deadline = setTimeout(() => finish({ result: "timeout" }), 25_000);
  globalThis.RTCPeerConnection = class extends NativePeer {
    constructor(config?: RTCConfiguration) {
      super(config); peers++; mark("ice_start");
      this.addEventListener("icegatheringstatechange", () => {
        if (this.iceGatheringState === "complete") mark("ice_complete");
      });
    }
    override createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, options);
      channel.addEventListener("open", () => mark("channel_open"));
      return channel;
    }
  };
  globalThis.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols); sockets++;
      this.addEventListener("open", () => mark("ws_open"));
    }
    override send(data: Parameters<WebSocket["send"]>[0]): void { relay_client_frames++; super.send(data); }
  };
  SessionTransport.prototype.rpc = async function (...args: Parameters<SessionTransport["rpc"]>): Promise<unknown> {
    const op = args[0], traced = op === "TransportOffer" || op === "TransportCommit";
    if (traced) mark(`${op}_sent`);
    try {
      const result = await rpc.apply(this, args);
      if (traced) mark(`${op}_answered`);
      return result;
    } catch (error) {
      if (traced) mark(`${op}_failed`);
      throw error;
    }
  };
  try {
    const url = new URL("/v2/ws", pair.relayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("role", "client"); url.searchParams.set("daemon_id", pair.daemonId);
    session = await sessionOverWS(url.href, pair, { networkMode: "auto", p2p: true, onP2PAttempt: finish });
    mark("relay_ready");
    const outcome = await finished;
    mark("direct_finished");
    return { ok: outcome.result === "connected", result: outcome.result, marks, peers, sockets, relay_client_frames };
  } catch (error) {
    return { ok: false, result: error instanceof ProtocolError ? error.code : "error", marks, peers, sockets, relay_client_frames };
  } finally {
    clearTimeout(deadline);
    session?.close();
    SessionTransport.prototype.rpc = rpc;
    globalThis.WebSocket = NativeSocket;
    globalThis.RTCPeerConnection = NativePeer;
    profiling = false;
  }
}
