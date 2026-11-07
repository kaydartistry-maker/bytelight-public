-- Permanent Letters — the vault tier that never thins.
-- Write-once. No maintenance job may ever be wired to this table;
-- separation from journal storage is itself the guarantee.
CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  recipients TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  seal TEXT NOT NULL,
  open_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  threshold_id TEXT,
  written_at TEXT NOT NULL,
  opened_at TEXT,
  opened_by TEXT
);
