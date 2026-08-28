export type SocketRole = "daemon" | "phone";
export type SocketMode = "hello" | "pairing" | "session";
export type BindKind = "none" | "pairing" | "resumehello" | "established";

export interface Attachment {
  v: 2;
  role: SocketRole;
  mode: SocketMode;
  route_id: string;
  kind: BindKind;
  created_ms: number;
  hello_at_ms: number;
  pair_ref: string;
  pair_frames: number;
}

export function newAttachment(
  role: SocketRole,
  now: number,
  extra?: Partial<Attachment>,
): Attachment {
  return {
    v: 2,
    role,
    mode: "hello",
    route_id: "",
    kind: "none",
    created_ms: now,
    hello_at_ms: 0,
    pair_ref: "",
    pair_frames: 0,
    ...extra,
  };
}

export function readAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 2) return null;
  if (o.role !== "daemon" && o.role !== "phone") return null;
  if (o.mode !== "hello" && o.mode !== "pairing" && o.mode !== "session") return null;
  if (o.kind !== "none" && o.kind !== "pairing" && o.kind !== "resumehello" && o.kind !== "established") return null;
  return {
    v: 2,
    role: o.role,
    mode: o.mode,
    route_id: typeof o.route_id === "string" ? o.route_id : "",
    kind: o.kind,
    created_ms: typeof o.created_ms === "number" ? o.created_ms : 0,
    hello_at_ms: typeof o.hello_at_ms === "number" ? o.hello_at_ms : 0,
    pair_ref: typeof o.pair_ref === "string" ? o.pair_ref : "",
    pair_frames: typeof o.pair_frames === "number" ? o.pair_frames : 0,
  };
}

export function isRegisteredDaemon(att: Attachment | null): boolean {
  return att?.role === "daemon" && att.hello_at_ms > 0;
}

export function needsConstructorSql(atts: Attachment[]): boolean {
  for (const a of atts) {
    if (a.kind === "pairing" || a.kind === "resumehello") return true;
    if (a.mode === "hello" && a.role === "phone") return true;
  }
  return false;
}
