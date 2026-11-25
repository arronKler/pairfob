import { randomBytes } from "../crypto.ts";
import type { Env } from "../env.ts";
import { buildOf } from "../http.ts";
import { roomMetrics } from "../metrics.ts";
import { NamespaceIndexClient } from "../index/client.ts";
import { CfSocket, wrapSockets } from "./cf-socket.ts";
import { CfStore } from "./cf-store.ts";
import { RoomCore } from "./core.ts";
import { handleRoomFetch } from "./http.ts";
import { watchUpgradeCancellation } from "./upgrade-cancellation.ts";
import { onMessage } from "./ws.ts";
import { RoomActivity } from "./activity.ts";

const closeReasons = new Set([
  "closed", "replaced", "kicked", "daemon_offline", "unpaired", "unbound",
  "pair_timeout", "pairing_expired", "bad_frame", "normal", "shutdown",
]);

// Peer-provided text must not enter metrics or notifications verbatim.
function closeReason(reason: string): string {
  return reason === "" ? "empty" : closeReasons.has(reason) ? reason : "other";
}

export class DaemonRoom {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly core: RoomCore;
  private readonly wraps = new WeakMap<WebSocket, CfSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    const store = new CfStore(ctx.storage);
    const self = this;
    const activity = new RoomActivity(ctx.storage, env.DB, ctx.id.name || "");
    this.core = new RoomCore({
      daemonId: ctx.id.name || "",
      store,
      now: () => Date.now(),
      randomBytes,
      sockets: () => wrapSockets(self.ctx.getWebSockets(), self.wraps),
      index: env.PAIRING_INDEX ? new NamespaceIndexClient(env.PAIRING_INDEX) : undefined,
      metrics: roomMetrics(env, ctx.id.name || ""),
      activity: (now) => ctx.waitUntil(activity.touch(now)),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.core.coldStart();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const build = buildOf(this.env);
    return handleRoomFetch(
      this.core,
      request,
      {
        upgrade: (att, tags, headers) => {
          const pair = new WebSocketPair();
          const client = pair[0];
          const server = pair[1];
          this.ctx.acceptWebSocket(server, tags);
          server.serializeAttachment(att);
          const wrapped = new CfSocket(server);
          this.wraps.set(server, wrapped);
          this.core.attachSocket(wrapped);
          watchUpgradeCancellation(request.signal, client, wrapped);
          return new Response(null, { status: 101, webSocket: client, headers });
        },
      },
      build,
    );
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    let wrapped = this.wraps.get(ws);
    if (!wrapped) {
      wrapped = new CfSocket(ws);
      this.wraps.set(ws, wrapped);
    }
    const socket = wrapped;
    // A close handshake can still deliver queued frames. Retired sockets must
    // neither answer PING nor register themselves again after hibernation.
    if (socket.isRetired()) return;
    return onMessage(this.core, socket, message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void | Promise<void> {
    let cleanupFailed = false;
    const wrapped = this.wraps.get(ws) ?? new CfSocket(ws);
    try {
      this.core.onClose(wrapped, closeReason(reason), code);
    } catch (error) {
      cleanupFailed = true;
      throw error;
    } finally {
      // Hibernating sockets still need a reciprocal Close frame. Use the raw
      // socket so retirement or an attachment/storage failure cannot skip it.
      try {
        if (code === 1005 || code === 1006) ws.close();
        else ws.close(code);
      } catch (error) {
        // Preserve the first failure if cleanup and the close reply both fail.
        if (!cleanupFailed) throw error;
      }
    }
    // Reply first so storage cannot delay the close handshake or retain its I/O.
    // A native CLOSING socket can still be returned by getWebSockets().
    this.wraps.set(ws, wrapped);
    return this.core.settleClosedSocket(wrapped);
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    // A non-disconnection error is not evidence that all peers must be closed.
  }

  async alarm(): Promise<void> {
    await this.core.alarm();
  }
}
