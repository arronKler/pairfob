import {
  CAS_ENROLL_SQL,
  CLEAR_ENROLL_NONCE_SQL,
  COMPENSATE_DAEMON_USED_SQL,
  COMPENSATE_USED_SQL,
  DELETE_DAEMON_SQL,
  INSERT_DAEMON_SQL,
  INSERT_SELF_GRANT_ROW_SQL,
  INSERT_SELF_GRANT_SQL,
  KICK_DAEMON_SQL,
  MARK_QUOTA_RELEASED_SQL,
  PRUNE_SELF_GRANTS_SQL,
  RELEASE_KICK_QUOTA_SQL,
  LIST_LIVE_DAEMON_IDS_SQL,
  SELECT_DAEMON_SQL,
  SELECT_GRANT_BY_ID_SQL,
  type DaemonRow,
  type GrantRow,
} from "../d1.ts";

class Bound implements D1PreparedStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new Bound(this.db, this.sql, values);
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.sql, this.values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.values);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    return this.db.all<T>(this.sql, this.values);
  }
}

export interface SelfGrantRow {
  grant_id: string;
  ip_hash: string;
  created_at: number;
}

export class FakeD1 implements D1Database {
  grants = new Map<string, GrantRow>();
  daemons = new Map<string, DaemonRow>();
  selfGrants = new Map<string, SelfGrantRow>();
  enrollNonces = new Map<string, string>();
  failNextInsert = false;

  prepare(query: string): D1PreparedStatement {
    return new Bound(this, query, []);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const grants = cloneMap(this.grants);
    const daemons = cloneMap(this.daemons);
    const selfGrants = cloneMap(this.selfGrants);
    const nonces = new Map(this.enrollNonces);
    try {
      const out: D1Result[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    } catch (error) {
      this.grants = grants;
      this.daemons = daemons;
      this.selfGrants = selfGrants;
      this.enrollNonces = nonces;
      throw error;
    }
  }

  run(sql: string, values: unknown[]): D1Result {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s === CAS_ENROLL_SQL) {
      const nonce = String(values[0]);
      const now = Number(values[1]);
      const id = String(values[2]);
      const cutoff = Number(values[3]);
      const g = this.grants.get(id);
      if (
        !g || g.revoked_at != null || g.used >= g.max_daemons || this.enrollNonces.has(id) ||
        (g.last_enroll_at != null && g.last_enroll_at > cutoff)
      ) return changes(0);
      g.used += 1;
      g.last_enroll_at = now;
      this.enrollNonces.set(id, nonce);
      return changes(1);
    }
    if (s === CLEAR_ENROLL_NONCE_SQL) {
      const id = String(values[0]);
      const nonce = String(values[1]);
      if (this.enrollNonces.get(id) !== nonce) return changes(0);
      this.enrollNonces.delete(id);
      return changes(1);
    }
    if (s === COMPENSATE_USED_SQL) {
      const id = String(values[0]);
      const g = this.grants.get(id);
      if (!g || g.used <= 0) return changes(0);
      g.used -= 1;
      return changes(1);
    }
    if (s === INSERT_DAEMON_SQL) {
      const grantID = String(values[4]);
      const nonce = String(values[5]);
      if (this.enrollNonces.get(grantID) !== nonce) return changes(0);
      if (this.failNextInsert) {
        this.failNextInsert = false;
        throw new Error("insert fail");
      }
      const row: DaemonRow = {
        daemon_id: String(values[0]),
        grant_id: String(values[1]),
        created_at: Number(values[2]),
        kicked_at: null,
        enroll_ip_hash: String(values[3]),
        quota_released_at: null,
      };
      this.daemons.set(row.daemon_id, row);
      return changes(1);
    }
    if (s === COMPENSATE_DAEMON_USED_SQL) {
      const grantID = String(values[0]);
      const daemonID = String(values[1]);
      const daemon = this.daemons.get(daemonID);
      const grant = this.grants.get(grantID);
      if (!daemon || daemon.grant_id !== String(values[2]) || daemon.quota_released_at != null || !grant || grant.used <= 0) {
        return changes(0);
      }
      grant.used -= 1;
      return changes(1);
    }
    if (s === DELETE_DAEMON_SQL) {
      const ok = this.daemons.delete(String(values[0]));
      return changes(ok ? 1 : 0);
    }
    if (s === INSERT_SELF_GRANT_SQL) {
      const grantID = String(values[0]);
      const ipHash = String(values[1]);
      const createdAt = Number(values[2]);
      const windowStart = Number(values[4]);
      const quota = Number(values[5]);
      let n = 0;
      for (const r of this.selfGrants.values()) {
        if (r.ip_hash === String(values[3]) && r.created_at > windowStart) n++;
      }
      if (n >= quota) return changes(0);
      this.selfGrants.set(grantID, { grant_id: grantID, ip_hash: ipHash, created_at: createdAt });
      return changes(1);
    }
    if (s === INSERT_SELF_GRANT_ROW_SQL) {
      if (!this.selfGrants.has(String(values[5]))) return changes(0);
      this.putGrant({
        grant_id: String(values[0]),
        grant_hash: String(values[1]),
        max_daemons: Number(values[2]),
        used: 0,
        label: (values[3] as string | null) ?? null,
        created_at: Number(values[4]),
        revoked_at: null,
        last_enroll_at: null,
      });
      return changes(1);
    }
    if (s === PRUNE_SELF_GRANTS_SQL) {
      const cutoff = Number(values[0]);
      let n = 0;
      for (const [id, r] of this.selfGrants) {
        if (r.created_at <= cutoff) {
          this.selfGrants.delete(id);
          n++;
        }
      }
      return changes(n);
    }
    if (s === KICK_DAEMON_SQL) {
      const d = this.daemons.get(String(values[1]));
      if (!d || d.kicked_at != null) return changes(0);
      d.kicked_at = Number(values[0]);
      return changes(1);
    }
    if (s === RELEASE_KICK_QUOTA_SQL) {
      const grantID = String(values[0]);
      const daemon = this.daemons.get(String(values[1]));
      const grant = this.grants.get(grantID);
      if (
        !daemon ||
        daemon.grant_id !== String(values[2]) ||
        daemon.kicked_at == null ||
        daemon.quota_released_at != null ||
        !grant ||
        grant.used <= 0
      ) return changes(0);
      grant.used -= 1;
      return changes(1);
    }
    if (s === MARK_QUOTA_RELEASED_SQL) {
      const daemon = this.daemons.get(String(values[1]));
      if (!daemon || daemon.kicked_at == null || daemon.quota_released_at != null) return changes(0);
      daemon.quota_released_at = Number(values[0]);
      return changes(1);
    }
    if (s.startsWith("SELECT")) return changes(0);
    throw new Error("unhandled SQL: " + s);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s === SELECT_GRANT_BY_ID_SQL) {
      return (this.grants.get(String(values[0])) ?? null) as T | null;
    }
    if (s === SELECT_DAEMON_SQL) {
      return (this.daemons.get(String(values[0])) ?? null) as T | null;
    }
    throw new Error("unhandled SQL first: " + s);
  }

  all<T>(sql: string, values: unknown[]): { results: T[]; success: boolean } {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s === LIST_LIVE_DAEMON_IDS_SQL) {
      const cap = Number(values[0] ?? 32);
      const rows: T[] = [];
      for (const d of this.daemons.values()) {
        if (d.kicked_at != null) continue;
        rows.push({ daemon_id: d.daemon_id } as T);
        if (rows.length >= cap) break;
      }
      return { results: rows, success: true };
    }
    const row = this.first<T>(sql, values);
    return { results: row ? [row] : [], success: true };
  }

  putGrant(row: GrantRow): void {
    this.grants.set(row.grant_id, row);
  }
}

function cloneMap<T extends object>(input: Map<string, T>): Map<string, T> {
  return new Map(Array.from(input, ([key, value]) => [key, { ...value }]));
}

function changes(n: number): D1Result {
  return { success: true, meta: { changes: n, last_row_id: 0 } };
}
