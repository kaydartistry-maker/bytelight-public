-- Artifacts — interactive React components for the phone's Artifacts app.
-- Ported from the inline CREATE in Aerie's services/db/init.ts.
-- Safe to run on every boot.

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  code TEXT NOT NULL,
  thumbnail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
