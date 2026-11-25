-- Companion registry — one row per pickable identity.
CREATE TABLE IF NOT EXISTS companions (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  avatar        TEXT,
  brain         TEXT NOT NULL,
  model         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_companions (
  thread_id     TEXT NOT NULL,
  companion_id  TEXT NOT NULL,
  PRIMARY KEY (thread_id, companion_id),
  FOREIGN KEY (thread_id)    REFERENCES threads(id)     ON DELETE CASCADE,
  FOREIGN KEY (companion_id) REFERENCES companions(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_companions_companion
  ON thread_companions (companion_id);

ALTER TABLE threads ADD COLUMN default_companion_id TEXT;

ALTER TABLE messages ADD COLUMN companion_id TEXT;
