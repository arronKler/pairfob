import type { Attachment } from "./attachment.ts";

export type AlarmKind =
  | "hello_5s"
  | "resume_15s"
  | "pair_first_15s"
  | "pair_confirm_30s"
  | "pair_ttl"
  | "ticket_15s";

export interface PairSlot {
  pair_ref: string;
  pair_loc: string;
  deadline: number;
}

export interface TicketRow {
  ticket: string;
  pair_ref: string;
  deadline: number;
}

export interface AlarmRow {
  id?: number;
  at: number;
  kind: AlarmKind;
  ref: string;
}

export interface MetaRow {
  daemon_id: string;
  reconnect_hash: string;
  grant_id: string;
  created_at: number;
}

export interface BindRow {
  route_id: string;
  kind: string;
  created_at: number;
  pair_ref: string;
}

export interface StoreStats {
  sql: number;
  getAlarm: number;
  setAlarm: number;
  deleteAlarm: number;
}

export interface RoomStore {
  readonly stats: StoreStats;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  setAlarmIfChanged(nextAt: number | null): Promise<void>;

  ensureSchema(): void;
  loadMeta(): MetaRow | null;
  putMeta(row: MetaRow): void;
  deleteMeta(): void;
  setReconnectHash(hash: string): void;
  clearReconnectHash(): void;

  loadSlot(): PairSlot | null;
  putSlot(slot: PairSlot): void;
  deleteSlot(): void;

  insertTicket(row: TicketRow): void;
  consumeTicket(ticket: string, now: number): TicketRow | null;
  expireTickets(now: number): void;

  listAlarms(): AlarmRow[];
  upsertAlarm(kind: AlarmKind, ref: string, at: number): void;
  deleteAlarmsByKindRef(kind: AlarmKind, ref: string): void;
  deleteAlarmIds(ids: number[]): void;
  minAlarmAt(): number | null;
  dueAlarms(now: number): AlarmRow[];

  upsertBind(row: BindRow): void;
  deleteBind(routeId: string): void;
  listBinds(): BindRow[];
  deleteGhostBinds(liveRouteIds: Set<string>): void;
}

export interface RoomSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(att: Attachment): void;
  deserializeAttachment(): Attachment | null;
}

export interface PairIndexClient {
  lookup(loc: string): Promise<{ daemon_id: string; pair_ref: string; exp: number } | null>;
  insert(row: { pair_loc: string; daemon_id: string; pair_ref: string; exp: number }): Promise<"ok" | "conflict" | "fail">;
  remove(pair_loc: string, owner: { daemon_id: string; pair_ref: string }): Promise<void>;
}

export interface RoomMetrics {
  bind(kind: string): void;
  close(code: string, kind: string): void;
  fwd(bytes: number): void;
  alarmLate(ms: number): void;
}

export interface RoomDeps {
  daemonId: string;
  store: RoomStore;
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  sockets: () => RoomSocket[];
  index?: PairIndexClient;
  metrics?: RoomMetrics;
}
