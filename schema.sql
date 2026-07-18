-- D1 schema for machinegrade-validate.
-- Apply with: wrangler d1 execute machinegrade-validate-db --file=schema.sql [--remote]

CREATE TABLE IF NOT EXISTS keys (
  key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  email TEXT,
  validator_type TEXT,
  valid INTEGER,
  latency_ms INTEGER,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_key ON events(key);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
