import { recordConnectionDiagnostic } from "./connection-diagnostics.ts";
import { ProtocolError } from "./errors.ts";
import { openWS, type FrameSocket } from "./frame-socket.ts";
import { muxProtocolFromRelayURL, muxSubprotocol } from "./mux.ts";

let nextConnectID = Date.now();
export function connectionTrace(warm = false): (event: string, code?: string) => void {
  const connectID = ++nextConnectID;
  const started = performance.now();
  const trace = (event: string, code?: string) => recordConnectionDiagnostic({
    event, code, transport: "relay", connect_id: connectID, elapsed_ms: performance.now() - started,
  });
  trace(warm ? "warmup_start" : "connect_start");
  return trace;
}

type Prepared = { socket: FrameSocket; trace: ReturnType<typeof connectionTrace> };
type Attempt = { controller: AbortController; result: Promise<Prepared | null>; socket?: FrameSocket };

/** Preconnect only: never sends HELLO, ATTACH or DeviceHello and cannot evict the live route. */
export class RelayWarmup {
  private attempt: Attempt | null = null;
  constructor(private readonly url: string) {}

  start(): void {
    if (this.attempt) return;
    const controller = new AbortController();
    const trace = connectionTrace(true);
    const attempt: Attempt = { controller, result: Promise.resolve(null) };
    this.attempt = attempt;
    attempt.result = openWS(this.url, muxSubprotocol(muxProtocolFromRelayURL(this.url)), controller.signal).then(socket => {
      if (controller.signal.aborted) { socket.close(); return null; }
      attempt.socket = socket;
      trace("ws_open");
      return { socket, trace };
    }, error => {
      trace(controller.signal.aborted ? "warmup_cancelled" : "connect_failed", error instanceof ProtocolError ? error.code : "error");
      return null;
    });
  }

  cancel(): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.controller.abort();
    attempt?.socket?.close();
  }

  async take(signal?: AbortSignal): Promise<Prepared | null> {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return null;
    const abort = () => { attempt.controller.abort(); attempt.socket?.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const prepared = await attempt.result;
      if (signal?.aborted || prepared?.socket.ws.readyState !== WebSocket.OPEN) {
        prepared?.socket.close();
        return null;
      }
      return prepared;
    } finally { signal?.removeEventListener("abort", abort); }
  }
}
