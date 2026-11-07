-- The Card Room: a 52-card deck, plus a back.
--
-- Deliberately game-agnostic. The Fleet Room's table knows it is Battleship,
-- because there was only ever going to be one board. This room is meant to hold
-- several games and they get designed together rather than guessed at, so the
-- table stores WHICH game is running and hands it an opaque state blob. Adding
-- a game should never need a migration.

CREATE TABLE IF NOT EXISTS card_tables (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT 'freeplay',
  status TEXT NOT NULL CHECK(status IN ('open', 'playing', 'complete')),
  -- the shuffled order, as card ids: the deck is dealt off the front of this
  deck_json TEXT NOT NULL DEFAULT '[]',
  -- one entry per seat, keyed by slug: each companion's, and the owner's
  seats_json TEXT NOT NULL DEFAULT '{}',
  -- face-up in the middle, most recent last
  pile_json TEXT NOT NULL DEFAULT '[]',
  -- whatever the running game needs and nothing else does
  state_json TEXT NOT NULL DEFAULT '{}',
  -- one companion turn at a time. Reserved with a compare-and-swap so two
  -- rail messages in quick succession cannot both open the lane.
  companion_pending INTEGER NOT NULL DEFAULT 0,
  companion_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);

CREATE INDEX IF NOT EXISTS idx_card_tables_created
  ON card_tables(created_at DESC);

CREATE TABLE IF NOT EXISTS card_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('system', 'play', 'chat')),
  actor TEXT NOT NULL,
  content TEXT NOT NULL,
  card TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (table_id) REFERENCES card_tables(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_log_table
  ON card_log(table_id, id);
