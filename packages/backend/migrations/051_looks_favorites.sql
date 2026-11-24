-- 051: looks get a favorite star (sorted first in the Spellbook and Studio
-- Create) and a starter tag for the old word presets seeded as looks.
-- Run one statement at a time; "duplicate column" means already done.
ALTER TABLE looks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE looks ADD COLUMN starter INTEGER NOT NULL DEFAULT 0;
