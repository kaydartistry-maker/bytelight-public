-- 044: turn leases — a phone message being answered, written down while its
-- turn waits and runs, so a restart that cuts the turn off doesn't lose it.
-- Idea from Myosia's crash journal; our own code. One row per turn:
--   prompt          the prompt the turn was given, as built by ws.ts
--   had_images      1 when pictures rode along (a retry carries text only)
--   attempts        how many times it has been retried after a restart
CREATE TABLE IF NOT EXISTS turn_leases (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  had_images INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
