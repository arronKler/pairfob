CREATE TABLE self_grants (
  grant_id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX self_grants_ip ON self_grants (ip_hash, created_at);
