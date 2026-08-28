import type { AlarmKind, AlarmRow, BindRow, MetaRow, PairSlot, RoomStore, StoreStats, TicketRow } from "./types.ts";

export class MemoryStore implements RoomStore {
  readonly stats: StoreStats = { sql: 0, getAlarm: 0, setAlarm: 0, deleteAlarm: 0 };
  private alarm: number | null = null;
  private meta: MetaRow | null = null;
  private slot: PairSlot | null = null;
  private tickets = new Map<string, TicketRow>();
  private alarms: AlarmRow[] = [];
  private nextAlarmId = 1;
  private binds = new Map<string, BindRow>();
  private schemed = false;

  private sql(): void {
    this.stats.sql++;
  }

  async getAlarm(): Promise<number | null> {
    this.stats.getAlarm++;
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.stats.setAlarm++;
    this.alarm = at;
  }

  async deleteAlarm(): Promise<void> {
    this.stats.deleteAlarm++;
    this.alarm = null;
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
    this.sql();
    this.schemed = true;
  }

  loadMeta(): MetaRow | null {
    this.sql();
    return this.meta ? { ...this.meta } : null;
  }

  putMeta(row: MetaRow): void {
    this.sql();
    this.meta = { ...row };
  }

  deleteMeta(): void {
    this.sql();
    this.meta = null;
  }

  setReconnectHash(hash: string): void {
    this.sql();
    if (this.meta) this.meta = { ...this.meta, reconnect_hash: hash };
  }

  clearReconnectHash(): void {
    this.sql();
    if (this.meta) this.meta = { ...this.meta, reconnect_hash: "" };
  }

  loadSlot(): PairSlot | null {
    this.sql();
    return this.slot ? { ...this.slot } : null;
  }

  putSlot(slot: PairSlot): void {
    this.sql();
    this.slot = { ...slot };
  }

  deleteSlot(): void {
    this.sql();
    this.slot = null;
  }

  insertTicket(row: TicketRow): void {
    this.sql();
    this.tickets.set(row.ticket, { ...row });
  }

  consumeTicket(ticket: string, now: number): TicketRow | null {
    this.sql();
    const row = this.tickets.get(ticket);
    if (!row || row.deadline <= now) return null;
    this.tickets.delete(ticket);
    return { ...row };
  }

  expireTickets(now: number): void {
    this.sql();
    for (const [k, v] of this.tickets) if (v.deadline <= now) this.tickets.delete(k);
  }

  listAlarms(): AlarmRow[] {
    this.sql();
    return this.alarms.map((a) => ({ ...a }));
  }

  upsertAlarm(kind: AlarmKind, ref: string, at: number): void {
    this.sql();
    this.alarms = this.alarms.filter((a) => !(a.kind === kind && a.ref === ref));
    this.alarms.push({ id: this.nextAlarmId++, at, kind, ref });
  }

  deleteAlarmsByKindRef(kind: AlarmKind, ref: string): void {
    this.sql();
    this.alarms = this.alarms.filter((a) => !(a.kind === kind && a.ref === ref));
  }

  deleteAlarmIds(ids: number[]): void {
    this.sql();
    const drop = new Set(ids);
    this.alarms = this.alarms.filter((a) => a.id === undefined || !drop.has(a.id));
  }

  minAlarmAt(): number | null {
    this.sql();
    if (this.alarms.length === 0) return null;
    return Math.min(...this.alarms.map((a) => a.at));
  }

  dueAlarms(now: number): AlarmRow[] {
    this.sql();
    return this.alarms.filter((a) => a.at <= now).map((a) => ({ ...a }));
  }

  upsertBind(row: BindRow): void {
    this.sql();
    this.binds.set(row.route_id, { ...row });
  }

  deleteBind(routeId: string): void {
    this.sql();
    this.binds.delete(routeId);
  }

  listBinds(): BindRow[] {
    this.sql();
    return [...this.binds.values()].map((b) => ({ ...b }));
  }

  deleteGhostBinds(liveRouteIds: Set<string>): void {
    this.sql();
    for (const k of this.binds.keys()) if (!liveRouteIds.has(k)) this.binds.delete(k);
  }

  /** Test helper: skip schema flag so we can inspect whether ensureSchema ran. */
  get schemedFlag(): boolean {
    return this.schemed;
  }
}
