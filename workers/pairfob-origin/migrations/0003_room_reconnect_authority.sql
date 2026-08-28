CREATE TABLE daemons_next (
  daemon_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kicked_at INTEGER,
  enroll_ip_hash TEXT,
  quota_released_at INTEGER
);

INSERT INTO daemons_next (daemon_id, grant_id, created_at, kicked_at, enroll_ip_hash, quota_released_at)
SELECT daemon_id, grant_id, created_at, kicked_at, enroll_ip_hash, quota_released_at FROM daemons;

DROP TABLE daemons;
ALTER TABLE daemons_next RENAME TO daemons;
CREATE INDEX daemons_grant_id ON daemons (grant_id);
