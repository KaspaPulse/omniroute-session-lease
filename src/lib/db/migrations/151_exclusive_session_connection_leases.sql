-- Opt-in, fenced, durable session-to-connection leases.
-- Partial UNIQUE indexes are the final cross-process exclusivity guard.
CREATE TABLE IF NOT EXISTS exclusive_connection_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'INVALIDATED')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exclusive_lease_active_owner
  ON exclusive_connection_leases(api_key_id, provider, owner_key)
  WHERE state = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_exclusive_lease_active_connection
  ON exclusive_connection_leases(provider, connection_id)
  WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_exclusive_lease_expiry_state
  ON exclusive_connection_leases(state, expires_at);

CREATE INDEX IF NOT EXISTS idx_exclusive_lease_connection_history
  ON exclusive_connection_leases(provider, connection_id, acquired_at);
