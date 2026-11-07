-- 026: the companion profile card — words about each companion, kept with him.
--
-- bio: written about the companion. Shown on his card, and read by his own
--      head when The Room runs a lane each (layered on the shared identity).
-- status / phone: card fields the phone app already shows.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; init.ts applies these one at a time
-- and treats "duplicate column" as already done.
ALTER TABLE companions ADD COLUMN bio TEXT;
ALTER TABLE companions ADD COLUMN status TEXT;
ALTER TABLE companions ADD COLUMN phone TEXT;
