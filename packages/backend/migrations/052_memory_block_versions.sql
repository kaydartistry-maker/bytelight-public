-- 052: a reversible history for core-memory blocks.
--
-- The ledger (017) keeps a receipt for every write, but for the destructive
-- ones (a whole-block set or rewrite, a delete) the receipt holds only sizes:
-- the text that was there is gone. This table keeps that text. One row is
-- written BEFORE a write that would lose something, holding the block exactly
-- as it stood, so any version can be read back or restored.
--
-- A write that only adds to the end of a block loses nothing and files no row
-- here; the ledger already holds what was added.
--
-- Pure CREATE ... IF NOT EXISTS: idempotent, safe to re-exec on every boot.
CREATE TABLE IF NOT EXISTS memory_block_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  -- The block's content and description as they stood before the write.
  content TEXT NOT NULL,
  description TEXT,
  -- What was about to happen: set | rethink | replace | insert | delete | restore.
  op TEXT NOT NULL,
  -- Who was writing (a lane, a companion slug, 'api' for the owner's screen).
  actor TEXT NOT NULL DEFAULT 'house',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_block_versions_block
  ON memory_block_versions(scope, label, id DESC);
