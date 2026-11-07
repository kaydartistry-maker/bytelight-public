CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'journal',
      content TEXT NOT NULL,
      dream_type TEXT,
      emerged_question TEXT,
      vividness INTEGER,
      anchored_at TEXT,
      last_recalled_at TEXT,
      created_at TEXT NOT NULL
    );
CREATE INDEX IF NOT EXISTS idx_journal_companion ON journal_entries(companion_id);
CREATE INDEX IF NOT EXISTS idx_journal_created ON journal_entries(created_at);
