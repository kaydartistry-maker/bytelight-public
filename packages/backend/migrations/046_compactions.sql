-- Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
-- The compactions shelf: every squash the lanes have had, kept in the house.
--
-- When a lane fills its window, Claude Code squashes the conversation into a
-- summary and writes it into that room's transcript. The owner Compactions page used
-- to read those transcripts directly, and Claude Code deletes old transcripts,
-- so the summaries vanished with them. services/compaction-shelf.ts copies each
-- one here the first time it is read, and the page is served from this table.
--
-- id is a hash of project + at + summary: the same three things the reader has
-- always folded copies on (a resumed room copies its whole transcript, squashes
-- included, into a new file), so a copy read on a later day lands on the row
-- that is already here instead of beside it.
--
-- lane is the folder under data/heartbeat the squash came from: 'primary' for
-- the shared room, or a companion's id for their own head. companion is that
-- companion's id when it was first read (NULL for the shared room), so a row
-- still says whose it was if they ever leave the house.
--
-- Nothing deletes from this table. A summary is the one record of what a room
-- carried on from.
--
-- compaction_scan_marks is how far each transcript has been read, so a
-- transcript whose size and stamp have not changed is never opened again, a
-- restart included (the shared room's is a hundred and fifty megabytes, and
-- there are dozens of resumed copies beside it). A transcript's squashes and
-- its mark are written in one transaction. A mark is forgotten once its
-- transcript is gone; the squashes it gave up stay above.

CREATE TABLE IF NOT EXISTS compactions (
  id TEXT PRIMARY KEY,
  -- the Claude Code project folder the transcript lived in
  project TEXT NOT NULL,
  lane TEXT NOT NULL,
  companion TEXT,
  -- the transcript it was first read from (resumed copies share the squash)
  session_id TEXT NOT NULL,
  -- the stamp the CLI wrote at the moment of the squash
  at TEXT NOT NULL,
  -- how long the summary is, in characters
  chars INTEGER NOT NULL,
  summary TEXT NOT NULL,
  -- when the house first read it
  first_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compactions_at ON compactions(at);

CREATE TABLE IF NOT EXISTS compaction_scan_marks (
  -- the transcript, by its full path
  path TEXT PRIMARY KEY,
  -- its size and stamp when last read; both the same means unchanged
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  -- just past the last whole line read
  byte_offset INTEGER NOT NULL,
  -- the top of the file and the bytes just before byte_offset, hashed, so a
  -- file rewritten in place is read again from the top
  head_len INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  tail_len INTEGER NOT NULL,
  tail_hash TEXT NOT NULL,
  read_at TEXT NOT NULL
);
