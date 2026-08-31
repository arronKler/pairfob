import { DAEMON_ID_RE, FWD_FLUSH_BYTES, HELLO_GRACE_MS, RESUME_MS, TICKET_MS, TICKET_RE } from "../constants.ts";
import { bytesToHex, sha256Hex, timingSafeEqual } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON, sendErr } from "../frames.ts";
import { harvestDue, syncHeapAlarm } from "./alarms.ts";
import { isRegisteredDaemon, needsConstructorSql, newAttachment, readAttachment, type Attachment } from "./attachment.ts";
import type { PairIndexClient, RoomDeps, RoomSocket, RoomStore } from "./types.ts";

export interface UpgradeOk {
  ok: true;
  attachment: Attachment;
  tags: string[];
}

export interface UpgradeFail {
  ok: false;
}

interface RouteTarget {
  socket: RoomSocket;
  routeId: Uint8Array;
}

export class RoomCore {
  readonly deps: RoomDeps;
  daemon: RoomSocket | null = null;
  reconnectHash = "";
  grantId = "";
  enrolled = false;
  fwdBytes = 0;
  fwdSinceWrite = 0;
  closeCount = 0;
  alarmLateMaxMs = 0;
  alarmLateCount = 0;
  private pairingTail: Promise<void> = Promise.resolve();
  /** Ephemeral hot-path index; WebSocket attachments remain the hibernation authority. */
  private readonly routes = new Map<string, RouteTarget>();

  constructor(deps: RoomDeps) {
    this.deps = deps;
  }

  get store(): RoomStore {
    return this.deps.store;
  }

  get daemonId(): string {
    return this.deps.daemonId;
  }

  now(): number {
    return this.deps.now();
  }

  random(n: number): Uint8Array {
    return this.deps.randomBytes(n);
  }

  async withPairingLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.pairingTail;
    let release!: () => void;
    this.pairingTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  sockets(): RoomSocket[] {
    return this.deps.sockets();
  }

  index(): PairIndexClient | undefined {
    return this.deps.index;
  }

  att(ws: RoomSocket): Attachment | null {
    return readAttachment(ws.deserializeAttachment());
  }

  writeAtt(ws: RoomSocket, att: Attachment): void {
    const previous = this.att(ws);
    if (previous?.route_id) this.routes.delete(previous.route_id);
    ws.serializeAttachment(att);
    if (att.route_id) this.rememberRoute(att.route_id, ws);
  }

  deleteBind(routeId: string): void {
    this.routes.delete(routeId);
    this.store.deleteBind(routeId);
  }

  rebuildMaps(): void {
    this.routes.clear();
    const daemons: RoomSocket[] = [];
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (isRegisteredDaemon(a)) daemons.push(ws);
      if (a?.route_id) this.rememberRoute(a.route_id, ws);
    }
    this.daemon = this.retainNewestDaemon(daemons);
  }

  /** Hibernation can leave more than one registered daemon socket. FWD must hit the newest. */
  retainNewestDaemon(daemons: RoomSocket[]): RoomSocket | null {
    if (daemons.length === 0) return null;
    let live = daemons[0];
    let liveHello = this.att(live)?.hello_at_ms ?? 0;
    for (let i = 1; i < daemons.length; i++) {
      const hello = this.att(daemons[i])?.hello_at_ms ?? 0;
      if (hello >= liveHello) {
        live = daemons[i];
        liveHello = hello;
      }
    }
    for (const ws of daemons) {
      if (ws === live) continue;
      try {
        ws.close(1000, "replaced");
      } catch {
        /* already closed */
      }
    }
    return live;
  }

  coldStart(): void {
    this.rebuildMaps();
    const atts: Attachment[] = [];
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a) atts.push(a);
    }
    if (!needsConstructorSql(atts)) return;
    this.harvestControl();
  }

  harvestControl(): void {
    const live = new Set<string>();
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a?.route_id) live.add(a.route_id);
    }
    this.store.deleteGhostBinds(live);
    const meta = this.store.loadMeta();
    if (meta) {
      this.enrolled = true;
      this.reconnectHash = meta.reconnect_hash;
      this.grantId = meta.grant_id;
    }
  }

  enroll(body: { reconnect_hash: string; grant_id: string }): { ok: boolean } {
    const existing = this.store.loadMeta();
    if (existing) {
      if (existing.reconnect_hash === body.reconnect_hash && existing.grant_id === body.grant_id) {
        this.enrolled = true;
        this.reconnectHash = existing.reconnect_hash;
        this.grantId = existing.grant_id;
        return { ok: true };
      }
      return { ok: false };
    }
    this.store.putMeta({
      daemon_id: this.daemonId,
      reconnect_hash: body.reconnect_hash,
      grant_id: body.grant_id,
      created_at: this.now(),
    });
    this.enrolled = true;
    this.reconnectHash = body.reconnect_hash;
    this.grantId = body.grant_id;
    return { ok: true };
  }

  verifyEnroll(reconnectHash: string, grantId: string): { ok: boolean } {
    const meta = this.store.loadMeta();
    return {
      ok: meta != null && meta.grant_id === grantId && timingSafeEqual(meta.reconnect_hash, reconnectHash),
    };
  }

  abortEnroll(reconnectHash: string, grantId: string): { ok: boolean } {
    const meta = this.store.loadMeta();
    if (!meta || meta.grant_id !== grantId || !timingSafeEqual(meta.reconnect_hash, reconnectHash)) {
      return { ok: false };
    }
    this.kick();
    this.store.deleteMeta();
    this.enrolled = false;
    this.grantId = "";
    return { ok: true };
  }

  rekey(oldHash: string, newHash: string): { ok: boolean } {
    const meta = this.store.loadMeta();
    if (!meta || meta.reconnect_hash === "") return { ok: false };
    if (timingSafeEqual(meta.reconnect_hash, newHash)) return { ok: true };
    if (!timingSafeEqual(meta.reconnect_hash, oldHash)) return { ok: false };
    this.store.setReconnectHash(newHash);
    this.reconnectHash = newHash;
    return { ok: true };
  }

  kick(): void {
    this.store.clearReconnectHash();
    this.reconnectHash = "";
    this.dropDaemon("kicked");
    for (const ws of this.sockets()) {
      try {
        ws.close(1000, "kicked");
      } catch {
        /* already closed */
      }
    }
    this.daemon = null;
  }

  async issueTicket(pairLoc: string): Promise<{ ok: true; pair_ticket: string; pair_ref: string } | { ok: false }> {
    const slot = this.store.loadSlot();
    const now = this.now();
    if (!slot || slot.pair_loc !== pairLoc || slot.deadline <= now) return { ok: false };
    const pair_ticket = bytesToHex(this.random(16));
    this.store.insertTicket({ ticket: pair_ticket, pair_ref: slot.pair_ref, deadline: now + TICKET_MS });
    this.store.upsertAlarm("ticket_15s", pair_ticket, now + TICKET_MS);
    await syncHeapAlarm(this.store);
    return { ok: true, pair_ticket, pair_ref: slot.pair_ref };
  }

  consumeUpgrade(params: URLSearchParams, role: string): UpgradeOk | UpgradeFail {
    const ticket = params.get("pair_ticket");
    if (ticket !== null && ticket !== "") {
      if (!TICKET_RE.test(ticket) || role !== "client") return { ok: false };
      const row = this.store.consumeTicket(ticket, this.now());
      if (!row) return { ok: false };
    }
    const att = newAttachment(role === "daemon" ? "daemon" : "phone", this.now());
    return { ok: true, attachment: att, tags: [att.role, att.kind] };
  }

  attachSocket(_ws: RoomSocket): void {
    this.rebuildMaps();
  }

  dropDaemon(reason: string): void {
    const daemon = this.daemon;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (!a || a.role === "daemon") continue;
      sendErr(ws, "daemon_offline", "daemon websocket gone");
      try {
        ws.close(1000, "daemon_offline");
      } catch {
        /* ignore */
      }
      if (a.route_id) this.deleteBind(a.route_id);
    }
    const slot = this.store.loadSlot();
    if (slot) {
      const loc = slot.pair_loc;
      this.store.deleteSlot();
      void this.index()?.remove(loc, { daemon_id: this.daemonId, pair_ref: slot.pair_ref });
    }
    this.daemon = null;
    if (daemon && reason === "replaced") {
      try {
        daemon.close(1000, "replaced");
      } catch {
        /* ignore */
      }
    }
    void reason;
  }

  notifyReplaced(): void {
    const id = this.daemonId;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (!a || a.role === "daemon") continue;
      const rid = a.route_id ? hexToRoute(a.route_id) : new Uint8Array(16);
      ws.send(encodeJSON(Typ.DAEMON_REPLACED, rid, { v: 2, daemon_id: id }));
      try {
        ws.close(1000, "replaced");
      } catch {
        /* ignore */
      }
      if (a.route_id) this.deleteBind(a.route_id);
    }
    const slot = this.store.loadSlot();
    if (slot) {
      const loc = slot.pair_loc;
      this.store.deleteSlot();
      void this.index()?.remove(loc, { daemon_id: this.daemonId, pair_ref: slot.pair_ref });
    }
  }

  noteFwd(bytes: number): void {
    if (bytes <= 0) return;
    this.fwdBytes += bytes;
    this.fwdSinceWrite += bytes;
    if (this.fwdSinceWrite >= FWD_FLUSH_BYTES) {
      this.deps.metrics?.fwd(this.fwdSinceWrite);
      this.fwdSinceWrite = 0;
    }
  }

  flushFwd(): void {
    if (this.fwdSinceWrite <= 0) return;
    this.deps.metrics?.fwd(this.fwdSinceWrite);
    this.fwdSinceWrite = 0;
  }

  noteBind(kind: string): void {
    this.deps.metrics?.bind(kind);
  }

  closeBind(ws: RoomSocket, code: string, message: string, notifyDaemon = true): void {
    const a = this.att(ws);
    const rid = a?.route_id ? hexToRoute(a.route_id) : undefined;
    sendErr(ws, code, message, rid ? { routeId: rid, pairRef: a?.pair_ref || undefined } : undefined);
    if (notifyDaemon && this.daemon && rid) {
      sendErr(this.daemon, code, message, { routeId: rid, pairRef: a?.pair_ref || undefined });
    }
    if (a?.route_id) this.deleteBind(a.route_id);
    try {
      ws.close(1000, code);
    } catch {
      /* ignore */
    }
  }

  noteAlarmLate(ms: number): void {
    this.alarmLateCount++;
    if (ms > this.alarmLateMaxMs) this.alarmLateMaxMs = ms;
    this.deps.metrics?.alarmLate(ms);
  }

  countKinds(): { est: number; resume: number; pairing: number } {
    let est = 0;
    let resume = 0;
    let pairing = 0;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (!a || a.role !== "phone") continue;
      if (a.kind === "established") est++;
      else if (a.kind === "resumehello") resume++;
      else if (a.kind === "pairing") pairing++;
    }
    return { est, resume, pairing };
  }

  countPendingHellos(): number {
    let pending = 0;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (!a || a.mode !== "hello" || a.kind !== "none") continue;
      if (isRegisteredDaemon(a)) continue;
      pending++;
    }
    return pending;
  }

  lruResume(): RoomSocket | null {
    let best: RoomSocket | null = null;
    let bestMs = Infinity;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (a?.kind !== "resumehello") continue;
      if (a.created_ms < bestMs) {
        bestMs = a.created_ms;
        best = ws;
      }
    }
    return best;
  }

  findByRoute(hex: string): RoomSocket | null {
    return this.routes.get(hex)?.socket ?? null;
  }

  routeBytes(hex: string): Uint8Array {
    return this.routes.get(hex)?.routeId ?? hexToRoute(hex);
  }

  private rememberRoute(hex: string, ws: RoomSocket): void {
    this.routes.set(hex, { socket: ws, routeId: hexToRoute(hex) });
  }

  onClose(ws: RoomSocket, reason = "closed"): void {
    this.closeCount++;
    const a = this.att(ws);
    const kind = a?.kind && a.kind !== "none" ? a.kind : a?.role || "none";
    this.flushFwd();
    this.deps.metrics?.close(reason || "closed", kind);
    if (a?.role === "daemon" && this.daemon === ws) {
      this.dropDaemon("closed");
      return;
    }
    if (a?.route_id) {
      if (this.daemon) {
        sendErr(this.daemon, "unpaired", "client websocket gone", { routeId: hexToRoute(a.route_id) });
      }
      this.deleteBind(a.route_id);
      a.kind = "none";
      a.route_id = "";
      this.writeAtt(ws, a);
    }
    if (a?.kind === "pairing") {
      /* slot remains until ttl; bind occupancy released via attachment gone */
    }
    this.rebuildMaps();
  }

  async alarm(): Promise<void> {
    await harvestDue(this);
    this.flushFwd();
    await syncHeapAlarm(this.store);
  }

  loadReconnectHash(): string {
    if (this.reconnectHash) return this.reconnectHash;
    const meta = this.store.loadMeta();
    if (meta) {
      this.reconnectHash = meta.reconnect_hash;
      this.grantId = meta.grant_id;
      this.enrolled = true;
    }
    return this.reconnectHash;
  }
}

export function hexToRoute(hex: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function assertDaemonId(id: string): boolean {
  return DAEMON_ID_RE.test(id);
}

export function helloDeadline(att: Attachment): number {
  return att.hello_at_ms + HELLO_GRACE_MS;
}

export function resumeDeadline(att: Attachment): number {
  return att.created_ms + RESUME_MS;
}
