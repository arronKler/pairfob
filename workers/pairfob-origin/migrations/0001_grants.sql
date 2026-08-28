CREATE TABLE grants (
  grant_id TEXT PRIMARY KEY,
  grant_hash TEXT NOT NULL UNIQUE,
  max_daemons INTEGER NOT NULL DEFAULT 2,
  used INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE daemons (
  daemon_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  reconnect_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kicked_at INTEGER,
  enroll_ip_hash TEXT
);

CREATE INDEX daemons_grant_id ON daemons (grant_id);
