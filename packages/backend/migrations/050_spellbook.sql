-- 050: the Spellbook gets a real home.
--
-- spells: one row per scene. `scene` holds the cast as [Character N] tokens,
-- so any cast can be written in later. Spells cast from a dropped picture are
-- 'mine'; prompts imported from the community vault are 'community' and carry
-- their author's credit. `original_text` keeps a vault prompt exactly as it
-- was written before the neutralize pass swapped its people for tokens.
-- `content_hash` is a hash of the normalized original prompt, so importing the
-- same vault twice never doubles anything. times_cast / last_cast_at drive the
-- "Not made" filter and Surprise me.
--
-- looks: style boards. A recipe (grain, color, light, lens) plus up to six
-- style pictures that only the recipe reader ever sees. One may be the default.
CREATE TABLE IF NOT EXISTS spells (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scene TEXT NOT NULL,
  original_text TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  look TEXT,
  origin TEXT NOT NULL DEFAULT 'mine',
  author TEXT,
  credit TEXT,
  link TEXT,
  source TEXT,
  vault TEXT,
  engine TEXT,
  content_hash TEXT,
  neutralized INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  times_cast INTEGER NOT NULL DEFAULT 0,
  last_cast_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spells_content_hash ON spells(content_hash);
CREATE INDEX IF NOT EXISTS idx_spells_origin ON spells(origin);
CREATE INDEX IF NOT EXISTS idx_spells_last_cast ON spells(last_cast_at);

CREATE TABLE IF NOT EXISTS looks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recipe TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  keep_picture INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
