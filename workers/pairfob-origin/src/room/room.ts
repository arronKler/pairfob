import { randomBytes } from "../crypto.ts";
import type { Env } from "../env.ts";
import { buildOf } from "../http.ts";
import { roomMetrics } from "../metrics.ts";
import { NamespaceIndexClient } from "../index/client.ts";
import { CfSocket, wrapSockets } from "./cf-socket.ts";
import { CfStore } from "./cf-store.ts";
import { RoomCore } from "./core.ts";
import { closeReason, diagnosticLog, frameLabel, isDiagnosticTarget, traceHandler } from "./diagnostics.ts";
import { handleRoomFetch } from "./http.ts";
import { watchUpgradeCancellation } from "./upgrade-cancellation.ts";
import { onMessage } from "./ws.ts";
import { lifecycleLog, socketCounts, socketFields, traceLifecycle } from "./lifecycle-diagnostics.ts";

export class DaemonRoom {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly core: RoomCore;
  private readonly wraps = new WeakMap<WebSocket, CfSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    const store = new CfStore(ctx.storage, Date.now, (previous, due, scheduled) => {
      diagnosticLog(env, ctx.id.toString(), {
        event: "room_alarm_rearmed", previous_at: previous, due_at: due, scheduled_at: scheduled,
      });
    });
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
      const target = isDiagnosticTarget(env, ctx.id.toString());
      if (target) lifecycleLog(env, ctx.id.toString(), "room_construct", () => ({ phase: "start" }));
      this.core.coldStart();
      if (target) lifecycleLog(env, ctx.id.toString(), "room_construct", () => ({ phase: "end", sql_calls: store.stats.sql }));
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
          const metadata = () => ({ ...socketFields(this.core.att(wrapped), server.readyState),
            ...socketCounts(this.ctx.getWebSockets()) });
          lifecycleLog(this.env, this.ctx.id.toString(), "room_upgrade_accepted", metadata);
          watchUpgradeCancellation(request.signal, client, wrapped, () => {
            diagnosticLog(this.env, this.ctx.id.toString(), {
              event: "room_upgrade_cancelled", role: att.role,
            });
          }, () => {
            lifecycleLog(this.env, this.ctx.id.toString(), "room_upgrade_abort_after_handoff", metadata);
          });
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
    const frame = frameLabel(message);
    const dispatch = () => traceHandler(this.env, this.ctx.id.toString(), frame, this.core.att(socket)?.role ?? "unknown",
      () => onMessage(this.core, socket, message));
    if (frame === "HELLO_DAEMON") {
      return traceLifecycle(this.env, this.ctx.id.toString(), "room_daemon_hello",
        () => ({ ...socketFields(this.core.att(socket), ws.readyState), ...socketCounts(this.ctx.getWebSockets()) }), dispatch);
    }
    return dispatch();
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    let cleanupFailed = false;
    let stage = "attachment";
    try {
      const wrapped = this.wraps.get(ws) ?? new CfSocket(ws);
      diagnosticLog(this.env, this.ctx.id.toString(), {
        event: "room_socket_close", code, was_clean: wasClean, reason: closeReason(reason),
        ...socketFields(this.core.att(wrapped), ws.readyState),
      });
      stage = "cleanup";
      this.core.onClose(wrapped, closeReason(reason));
    } catch (error) {
      cleanupFailed = true;
      diagnosticLog(this.env, this.ctx.id.toString(), { event: "room_close_failed", stage, code });
      throw error;
    } finally {
      // Hibernating sockets still need a reciprocal Close frame. Use the raw
      // socket so retirement or an attachment/storage failure cannot skip it.
      try {
        if (code === 1005 || code === 1006) ws.close();
        else ws.close(code);
      } catch (error) {
        diagnosticLog(this.env, this.ctx.id.toString(), { event: "room_close_failed", stage: "reply", code });
        // Preserve the first failure if cleanup and the close reply both fail.
        if (!cleanupFailed) throw error;
      }
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    const wrapped = this.wraps.get(ws) ?? new CfSocket(ws);
    // A non-disconnection error is not evidence that all peers must be closed.
    diagnosticLog(this.env, this.ctx.id.toString(), {
      event: "room_socket_error", role: this.core.att(wrapped)?.role ?? "unknown",
    });
  }

  async alarm(): Promise<void> {
    await traceLifecycle(this.env, this.ctx.id.toString(), "room_alarm",
      () => socketCounts(this.ctx.getWebSockets()), () => this.core.alarm());
  }
}
