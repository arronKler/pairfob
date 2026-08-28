import { randomBytes } from "../crypto.ts";
import type { Env } from "../env.ts";
import { buildOf } from "../http.ts";
import { roomMetrics } from "../metrics.ts";
import { NamespaceIndexClient } from "../index/client.ts";
import { CfSocket, wrapSockets } from "./cf-socket.ts";
import { CfStore } from "./cf-store.ts";
import { RoomCore } from "./core.ts";
import { handleRoomFetch } from "./http.ts";
import { onMessage } from "./ws.ts";

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
    this.core = new RoomCore({
      daemonId: ctx.id.name || "",
      store,
      now: () => Date.now(),
      randomBytes,
      sockets: () => wrapSockets(self.ctx.getWebSockets(), self.wraps),
      index: env.PAIRING_INDEX ? new NamespaceIndexClient(env.PAIRING_INDEX) : undefined,
      metrics: roomMetrics(env, ctx.id.name || ""),
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
    return onMessage(this.core, wrapped, message);
  }

  async webSocketClose(ws: WebSocket, _code: number, reason: string, _wasClean: boolean): Promise<void> {
    const wrapped = this.wraps.get(ws) ?? new CfSocket(ws);
    this.core.onClose(wrapped, reason || "closed");
  }

  async alarm(): Promise<void> {
    await this.core.alarm();
  }
}
