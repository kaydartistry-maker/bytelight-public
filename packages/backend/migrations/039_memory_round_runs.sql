-- 039: memory integrity rounds — one row per UTC day (ported from Aerie, which
-- creates this inline in init.ts). See services/memory-rounds.ts.
CREATE TABLE IF NOT EXISTS memory_round_runs (
  day TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT
);
