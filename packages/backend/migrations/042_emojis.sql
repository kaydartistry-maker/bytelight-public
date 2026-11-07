-- Custom emojis and emoji packs (ported from the full-sweep house, where they
-- were migrations 004/005). Separate from stickers. Written as one
-- CREATE IF NOT EXISTS pair with pack_id inline, so it is a no-op on a
-- database that already carries these tables and safe on every boot.
CREATE TABLE IF NOT EXISTS emoji_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  user_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emojis (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  pack_id TEXT REFERENCES emoji_packs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_emojis_name ON emojis(name);
CREATE INDEX IF NOT EXISTS idx_emojis_pack_id ON emojis(pack_id);
