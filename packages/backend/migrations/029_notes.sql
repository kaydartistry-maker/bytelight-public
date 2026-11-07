-- 029: sticky notes for the phone's Notes app.
-- Ported from Aerie (Tris) — the `notes` table from Aerie's services/db/init.ts.
-- Numbered 029, not 028: 028 is held by the Scribe branch, still unmerged.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#fef08a',
  timestamp TEXT NOT NULL,
  sender TEXT
);
