import { ROOM_DDL } from "./schema.ts";
import type { AlarmKind, AlarmRow, BindRow, MetaRow, PairSlot, RoomStore, StoreStats, TicketRow } from "./types.ts";

interface SqlExec {
  exec<T = Record<string, unknown>>(query: string, ...binds: unknown[]): {
    toArray(): T[];
    rowsWritten: number;
  };
}

export class CfStore implements RoomStore {
  readonly stats: StoreStats = { sql: 0, getAlarm: 0, setAlarm: 0, deleteAlarm: 0 };
  private schemed = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlExec {
    return this.storage.sql;
  }

  private exec<T = Record<string, unknown>>(query: string, ...binds: unknown[]): {
    toArray(): T[];
    rowsWritten: number;
  } {
    this.stats.sql++;
    return this.sql.exec<T>(query, ...binds);
  }

  async getAlarm(): Promise<number | null> {
    this.stats.getAlarm++;
    const v = await this.storage.getAlarm();
    return v ?? null;
  }

  async setAlarm(at: number): Promise<void> {
    this.stats.setAlarm++;
    await this.storage.setAlarm(at);
  }

  async deleteAlarm(): Promise<void> {
    this.stats.deleteAlarm++;
    await this.storage.deleteAlarm();
  }

  async setAlarmIfChanged(nextAt: number | null): Promise<void> {
    const cur = await this.getAlarm();
    if (nextAt === null) {
      if (cur != null) await this.deleteAlarm();
      return;
    }
    if (cur !== nextAt) await this.setAlarm(nextAt);
  }

  ensureSchema(): void {
    if (this.schemed) return;
    for (const stmt of ROOM_DDL) this.exec(stmt);
    this.schemed = true;
  }

  loadMeta(): MetaRow | null {
    this.ensureSchema();
    const rows = this.exec<MetaRow>("SELECT daemon_id, reconnect_hash, grant_id, created_at FROM meta LIMIT 1").toArray();
    return rows[0] ?? null;
  }

  putMeta(row: MetaRow): void {
    this.ensureSchema();
    this.exec("DELETE FROM meta");
    this.exec(
      "INSERT INTO meta (daemon_id, reconnect_hash, grant_id, created_at) VALUES (?, ?, ?, ?)",
      row.daemon_id,
      row.reconnect_hash,
      row.grant_id,
      row.created_at,
    );
  }

  deleteMeta(): void {
    this.ensureSchema();
    this.exec("DELETE FROM meta");
  }

  setReconnectHash(hash: string): void {
    this.ensureSchema();
    this.exec("UPDATE meta SET reconnect_hash = ?", hash);
  }

  clearReconnectHash(): void {
    this.ensureSchema();
    this.exec("UPDATE meta SET reconnect_hash = ''");
  }

  loadSlot(): PairSlot | null {
    this.ensureSchema();
    const rows = this.exec<PairSlot>("SELECT pair_ref, pair_loc, deadline FROM pair_slot LIMIT 1").toArray();
    return rows[0] ?? null;
  }

  putSlot(slot: PairSlot): void {
    this.ensureSchema();
    this.exec("DELETE FROM pair_slot");
    this.exec(
      "INSERT INTO pair_slot (pair_ref, pair_loc, deadline) VALUES (?, ?, ?)",
      slot.pair_ref,
      slot.pair_loc,
      slot.deadline,
    );
  }

  deleteSlot(): void {
    this.ensureSchema();
    this.exec("DELETE FROM pair_slot");
  }

  insertTicket(row: TicketRow): void {
    this.ensureSchema();
    this.exec(
      "INSERT INTO pair_tickets (ticket, pair_ref, deadline) VALUES (?, ?, ?)",
      row.ticket,
      row.pair_ref,
      row.deadline,
    );
  }

  consumeTicket(ticket: string, now: number): TicketRow | null {
    this.ensureSchema();
    const rows = this.exec<TicketRow>(
      "SELECT ticket, pair_ref, deadline FROM pair_tickets WHERE ticket = ? AND deadline > ?",
      ticket,
      now,
    ).toArray();
    const row = rows[0];
    if (!row) return null;
    const del = this.exec("DELETE FROM pair_tickets WHERE ticket = ? AND deadline > ?", ticket, now);
    if (del.rowsWritten !== 1) return null;
    return row;
  }

  expireTickets(now: number): void {
    this.ensureSchema();
    this.exec("DELETE FROM pair_tickets WHERE deadline <= ?", now);
  }

  listAlarms(): AlarmRow[] {
    this.ensureSchema();
    return this.exec<AlarmRow>("SELECT id, at, kind, ref FROM alarms").toArray() as AlarmRow[];
  }

  upsertAlarm(kind: AlarmKind, ref: string, at: number): void {
    this.ensureSchema();
    this.exec("DELETE FROM alarms WHERE kind = ? AND ref = ?", kind, ref);
    this.exec("INSERT INTO alarms (at, kind, ref) VALUES (?, ?, ?)", at, kind, ref);
  }

  deleteAlarmsByKindRef(kind: AlarmKind, ref: string): void {
    this.ensureSchema();
    this.exec("DELETE FROM alarms WHERE kind = ? AND ref = ?", kind, ref);
  }

  deleteAlarmIds(ids: number[]): void {
    this.ensureSchema();
    for (const id of ids) this.exec("DELETE FROM alarms WHERE id = ?", id);
  }

  minAlarmAt(): number | null {
    this.ensureSchema();
    const rows = this.exec<{ m: number | null }>("SELECT MIN(at) AS m FROM alarms").toArray();
    const m = rows[0]?.m;
    return m == null ? null : m;
  }

  dueAlarms(now: number): AlarmRow[] {
    this.ensureSchema();
    return this.exec<AlarmRow>("SELECT id, at, kind, ref FROM alarms WHERE at <= ?", now).toArray() as AlarmRow[];
  }

  upsertBind(row: BindRow): void {
    this.ensureSchema();
    this.exec(
      "INSERT INTO binds (route_id, kind, created_at, pair_ref) VALUES (?, ?, ?, ?) ON CONFLICT(route_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at, pair_ref = excluded.pair_ref",
      row.route_id,
      row.kind,
      row.created_at,
      row.pair_ref,
    );
  }

  deleteBind(routeId: string): void {
    this.ensureSchema();
    this.exec("DELETE FROM binds WHERE route_id = ?", routeId);
  }

  listBinds(): BindRow[] {
    this.ensureSchema();
    return this.exec<BindRow>("SELECT route_id, kind, created_at, pair_ref FROM binds").toArray();
  }

  deleteGhostBinds(liveRouteIds: Set<string>): void {
    this.ensureSchema();
    const rows = this.listBinds();
    for (const r of rows) if (!liveRouteIds.has(r.route_id)) this.deleteBind(r.route_id);
  }
}
