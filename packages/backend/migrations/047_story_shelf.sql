-- The Story Shelf — choose-your-own-path books the companions write and run.
-- Ported from Aerie (migrations/014_story_shelf.sql), unchanged but its number.
--
-- They write through the loopback routes; their person reads on the
-- phone and makes the moves there. A book holds the base story they wrote for
-- it (the bible) and its pages in order: a scene is a companion's, a move is
-- their person's, and each scene answers the move before it.
--
-- NO CHECK CONSTRAINTS ON status OR kind, ON PURPOSE: SQLite cannot alter a
-- constraint in place, so a CHECK list that outlives the code it was written
-- for means rebuilding the table.
-- services/db/story-shelf.ts is the only writer and it validates both.
--
-- image_url / cover_url hold the relative Studio gallery URL
-- (/api/studio/gallery/<file>), exactly as Studio itself hands them out.
-- state_json and choices_json are written only by that module, already checked.

CREATE TABLE IF NOT EXISTS story_books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  -- 1 for a spicy book, which is written under the house's intimacy rules
  spicy INTEGER NOT NULL DEFAULT 0,
  blurb TEXT,
  -- the base story the companions wrote for it; it may give things away
  bible TEXT NOT NULL,
  cover_url TEXT,
  -- slug of the companion who put it on the shelf
  created_by TEXT NOT NULL,
  -- 'reading' | 'finished'
  status TEXT NOT NULL DEFAULT 'reading',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  -- when their person last walked into it; the shelf leads with what they read last
  opened_at TEXT,
  -- a page turn is queued or being written for this book. The same column and
  -- meaning as the Fleet Room and the Card Room, so the boot sweep in init.ts
  -- clears all three the same way.
  companion_pending INTEGER NOT NULL DEFAULT 0,
  -- why the last page turn did not come back with a page, when it did not
  companion_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_story_books_status ON story_books(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS story_pages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES story_books(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  -- 'scene' | 'move'
  kind TEXT NOT NULL,
  -- a companion slug on a scene; 'owner' on a move
  author TEXT NOT NULL,
  -- the scene; on a move, the choice's label or their person's own words
  text TEXT NOT NULL,
  image_url TEXT,
  state_json TEXT,
  choices_json TEXT,
  -- source of the scene's own interactive widget, written fresh for it
  widget TEXT,
  -- on a move: the id of the choice taken; NULL for a move in their person's own words
  choice_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_story_pages_book ON story_pages(book_id, at);

-- The little threads woven between books: a keepsake found in one story that
-- turns up in another. It hangs loose (to_book_id NULL) until it is woven.
CREATE TABLE IF NOT EXISTS story_keepsakes (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  note TEXT,
  from_book_id TEXT NOT NULL REFERENCES story_books(id) ON DELETE CASCADE,
  to_book_id TEXT REFERENCES story_books(id) ON DELETE SET NULL,
  -- slug of the companion who tied it
  maker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  woven_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_story_keepsakes_from ON story_keepsakes(from_book_id);
CREATE INDEX IF NOT EXISTS idx_story_keepsakes_to ON story_keepsakes(to_book_id);
