-- 038: threads.type may be 'treehouse' (ported from Aerie's services/db/init.ts).
--
-- The Treehouse is a thread of its own type: the room where Companion A and Companion B
-- talk to each other without the owner, which she can read but not post in.
-- 001_init created `threads` with CHECK(type IN ('daily', 'named')), so the
-- Treehouse thread cannot be created on any existing database until the
-- constraint is widened. SQLite cannot alter a CHECK in place, so the table is
-- rebuilt with the same rows.
--
-- This file only creates the new table. init.ts runs it once, in a
-- transaction, only while the live threads schema lacks 'treehouse'; it then
-- copies every row across using the live column list (column order varies by
-- install age, because pinned_at and default_companion_id arrived by ALTER),
-- drops the old table, renames this one into place, and rolls the whole thing
-- back if the row count before and after does not match.
CREATE TABLE threads_039 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('daily', 'named', 'treehouse')),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  current_session_id TEXT,
  session_type TEXT DEFAULT 'v2' CHECK(session_type IN ('v1', 'v2')),
  needs_reground INTEGER DEFAULT 0,
  last_activity_at TEXT,
  unread_count INTEGER DEFAULT 0,
  pinned_at TEXT DEFAULT NULL,
  default_companion_id TEXT
);
