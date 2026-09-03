export const CAS_ENROLL_SQL =
  "UPDATE grants SET used = used + 1, enroll_nonce = ?, last_enroll_at = ? WHERE grant_id = ? AND revoked_at IS NULL AND used < max_daemons AND enroll_nonce IS NULL AND (last_enroll_at IS NULL OR last_enroll_at <= ?)";

export const COMPENSATE_USED_SQL = "UPDATE grants SET used = used - 1 WHERE grant_id = ? AND used > 0";

export const INSERT_DAEMON_SQL =
  "INSERT INTO daemons (daemon_id, grant_id, created_at, kicked_at, enroll_ip_hash, quota_released_at) SELECT ?, ?, ?, NULL, ?, NULL FROM grants WHERE grant_id = ? AND enroll_nonce = ?";

export const CLEAR_ENROLL_NONCE_SQL =
  "UPDATE grants SET enroll_nonce = NULL WHERE grant_id = ? AND enroll_nonce = ?";

export const COMPENSATE_DAEMON_USED_SQL =
  "UPDATE grants SET used = used - 1 WHERE grant_id = ? AND used > 0 AND EXISTS (SELECT 1 FROM daemons WHERE daemon_id = ? AND grant_id = ? AND quota_released_at IS NULL)";

export const DELETE_DAEMON_SQL = "DELETE FROM daemons WHERE daemon_id = ?";

export const SELECT_GRANT_BY_ID_SQL = "SELECT * FROM grants WHERE grant_id = ?";

export const SELECT_DAEMON_SQL = "SELECT * FROM daemons WHERE daemon_id = ?";

export const LIST_LIVE_DAEMON_IDS_SQL = "SELECT daemon_id FROM daemons WHERE kicked_at IS NULL LIMIT ?";

export const KICK_DAEMON_SQL =
  "UPDATE daemons SET kicked_at = ? WHERE daemon_id = ? AND kicked_at IS NULL";

export const RELEASE_KICK_QUOTA_SQL =
  "UPDATE grants SET used = used - 1 WHERE grant_id = ? AND used > 0 AND EXISTS (SELECT 1 FROM daemons WHERE daemon_id = ? AND grant_id = ? AND kicked_at IS NOT NULL AND quota_released_at IS NULL)";

export const MARK_QUOTA_RELEASED_SQL =
  "UPDATE daemons SET quota_released_at = ? WHERE daemon_id = ? AND kicked_at IS NOT NULL AND quota_released_at IS NULL";

// The per-IP cap lives in the INSERT so two concurrent open enrolls from one
// address cannot both read an under-quota count and then both write.
export const INSERT_SELF_GRANT_SQL =
  "INSERT INTO self_grants (grant_id, ip_hash, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM self_grants WHERE ip_hash = ? AND created_at > ?) < ?";

export const INSERT_SELF_GRANT_ROW_SQL =
  "INSERT INTO grants (grant_id, grant_hash, max_daemons, used, label, created_at, revoked_at) SELECT ?, ?, ?, 0, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM self_grants WHERE grant_id = ?)";

export const PRUNE_SELF_GRANTS_SQL = "DELETE FROM self_grants WHERE created_at <= ?";

export interface GrantRow {
  grant_id: string;
  grant_hash: string;
  max_daemons: number;
  used: number;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
  last_enroll_at: number | null;
}

export interface DaemonRow {
  daemon_id: string;
  grant_id: string;
  created_at: number;
  kicked_at: number | null;
  enroll_ip_hash: string | null;
  quota_released_at: number | null;
}

export async function getGrantById(db: D1Database, grantId: string): Promise<GrantRow | null> {
  return db.prepare(SELECT_GRANT_BY_ID_SQL).bind(grantId).first<GrantRow>();
}

export async function getDaemon(db: D1Database, daemonId: string): Promise<DaemonRow | null> {
  return db.prepare(SELECT_DAEMON_SQL).bind(daemonId).first<DaemonRow>();
}

export async function enrollDaemonBatch(
  db: D1Database,
  row: {
    daemon_id: string;
    grant_id: string;
    created_at: number;
    enroll_ip_hash: string;
  },
): Promise<number> {
  const nonce = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(CAS_ENROLL_SQL).bind(nonce, row.created_at, row.grant_id, row.created_at - 60_000),
    db
      .prepare(INSERT_DAEMON_SQL)
      .bind(
        row.daemon_id,
        row.grant_id,
        row.created_at,
        row.enroll_ip_hash,
        row.grant_id,
        nonce,
      ),
    db.prepare(CLEAR_ENROLL_NONCE_SQL).bind(row.grant_id, nonce),
  ]);
  return results[0]?.meta.changes ?? 0;
}

export async function compensateEnroll(db: D1Database, grantId: string, daemonId: string): Promise<void> {
  await db.batch([
    db.prepare(COMPENSATE_DAEMON_USED_SQL).bind(grantId, daemonId, grantId),
    db.prepare(DELETE_DAEMON_SQL).bind(daemonId),
  ]);
}

/**
 * Claims one per-IP open-enroll slot and mints the grant in the same batch, so
 * a refused claim cannot leave a usable grant behind. Rows at or below
 * `window_start` are outside the counting window, so pruning them is safe.
 */
export async function insertSelfServeGrant(
  db: D1Database,
  row: {
    grant_id: string;
    grant_hash: string;
    ip_hash: string;
    max_daemons: number;
    label: string | null;
    created_at: number;
    window_start: number;
    quota: number;
  },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(INSERT_SELF_GRANT_SQL)
      .bind(row.grant_id, row.ip_hash, row.created_at, row.ip_hash, row.window_start, row.quota),
    db
      .prepare(INSERT_SELF_GRANT_ROW_SQL)
      .bind(row.grant_id, row.grant_hash, row.max_daemons, row.label, row.created_at, row.grant_id),
    db.prepare(PRUNE_SELF_GRANTS_SQL).bind(row.window_start),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
}

export async function kickDaemonRow(
  db: D1Database,
  daemonId: string,
  now: number,
): Promise<{ kicked: boolean; grant_id: string } | null> {
  const row = await getDaemon(db, daemonId);
  if (!row) return null;
  const results = await db.batch([
    db.prepare(KICK_DAEMON_SQL).bind(now, daemonId),
    db.prepare(RELEASE_KICK_QUOTA_SQL).bind(row.grant_id, daemonId, row.grant_id),
    db.prepare(MARK_QUOTA_RELEASED_SQL).bind(now, daemonId),
  ]);
  return { kicked: (results[0]?.meta.changes ?? 0) === 1, grant_id: row.grant_id };
}

export async function listLiveDaemonIds(db: D1Database, limit = 32): Promise<string[]> {
  const cap = Math.min(Math.max(1, limit), 64);
  const r = await db.prepare(LIST_LIVE_DAEMON_IDS_SQL).bind(cap).all<{ daemon_id: string }>();
  return (r.results ?? []).map((row) => row.daemon_id);
}

export function classifyCasMiss(row: GrantRow | null, now: number): "bad_grant" | "grant_exhausted" | "rate_limited" {
  if (!row || row.revoked_at != null) return "bad_grant";
  if (row.used >= row.max_daemons) return "grant_exhausted";
  if (row.last_enroll_at != null && now - row.last_enroll_at < 60_000) return "rate_limited";
  return "bad_grant";
}
