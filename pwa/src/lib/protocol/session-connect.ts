import { jsonFrame, Typ } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import { envelopeError, openWS, send, Z16 } from "./frame-socket.ts";
import { helloClientBody, muxProtocolFromRelayURL, muxSubprotocol, sessionAttachBody } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";
import { connectionTrace, type RelayWarmup } from "./relay-warmup.ts";
import { establishSessionEpoch } from "./session-handshake.ts";
import { SessionTransport } from "./session-transport.ts";
import type { SessionEvent } from "./session-types.ts";

/** One authenticated relay attempt; timing includes speculative WebSocket preparation, if any. */
export async function connectSession(
  relayWS: string,
  pair: PairResult,
  emit: (event: SessionEvent) => void,
  signal?: AbortSignal,
  warmup?: RelayWarmup,
): Promise<SessionTransport> {
  const protocol = muxProtocolFromRelayURL(relayWS);
  const prepared = await warmup?.take(signal);
  const trace = prepared?.trace ?? connectionTrace();
  let socket = prepared?.socket;
  let transport: SessionTransport | undefined;
  const abort = () => socket?.ws.close(1000, "connection cancelled");
  try {
    if (!socket) {
      socket = await openWS(relayWS, muxSubprotocol(protocol), signal);
      trace("ws_open");
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw new ProtocolError("disconnected", "连接已取消");
    send(socket.ws, jsonFrame(Typ.HELLO_CLIENT, Z16, helloClientBody(protocol)));
    send(socket.ws, jsonFrame(Typ.SESSION_ATTACH, Z16, sessionAttachBody(protocol, pair.daemonId)));
    const bound = await socket.next(8_000);
    if (bound.typ === Typ.ERROR) throw envelopeError(bound);
    if (bound.typ !== Typ.SESSION_BOUND) throw new ProtocolError("bad_message", `预期 SESSION_BOUND，实际 ${bound.typ}`);
    trace("route_bound");
    const epoch = await establishSessionEpoch(socket, bound.routeId, pair, protocol, trace);
    transport = new SessionTransport(socket, epoch.routeId, epoch.c2s, epoch.s2c, emit);
    // A fresh encrypted response is still required before enabling operations.
    await transport.rpc("Ping", { t_ms: Date.now() }, 8_000);
    if (signal?.aborted) throw new ProtocolError("disconnected", "连接已取消");
    trace("session_ready");
    return transport;
  } catch (error) {
    trace("connect_failed", error instanceof ProtocolError ? error.code : "error");
    if (transport) transport.close();
    else socket?.ws.close(1000, "session handshake failed");
    throw error;
  } finally { signal?.removeEventListener("abort", abort); }
}
