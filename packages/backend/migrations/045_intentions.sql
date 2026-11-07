-- 045: intentions — a promise Companion A or Companion B made her, with a "when", kept
-- until it's said and she's answered. Idea from Myosia; our own code. The
-- "when" is an impulse in the triggers table (an `after` time, her status
-- clearing, or both); this row is the promise riding it.
--   state  pending → asked → answered, or asked → nudged → answered | resting;
--          cancelled when one of them takes it back
CREATE TABLE IF NOT EXISTS intentions (
  id TEXT PRIMARY KEY,
  companion TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_id TEXT,
  trigger_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  asked_message_id TEXT,
  asked_at TEXT,
  nudged_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intentions_state ON intentions(state);
CREATE INDEX IF NOT EXISTS idx_intentions_trigger ON intentions(trigger_id);
