-- 027: a lane on every Codex/Claude session card, so one thread can hold a
-- conversation per companion when The Room runs "A Lane Each".
--
-- thread_provider_sessions is the house's address book: thread + runtime +
-- provider + model → the provider-side session/conversation id to resume.
-- It had no room for WHICH companion, so two companions on Codex in the same
-- thread would overwrite each other's card. `lane` is '' for the shared lane
-- (every existing row) and the companion's id for his own lane.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt with
-- the same rows. init.ts runs this once, in a transaction, only when the
-- `lane` column is missing.
CREATE TABLE thread_provider_sessions_027 (
  thread_id     TEXT NOT NULL,
  lane          TEXT NOT NULL DEFAULT '',
  runtime_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model_ref     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (thread_id, lane, runtime_id, provider, model_ref),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

INSERT INTO thread_provider_sessions_027
  (thread_id, lane, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json)
SELECT thread_id, '', runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
FROM thread_provider_sessions;

DROP TABLE thread_provider_sessions;

ALTER TABLE thread_provider_sessions_027 RENAME TO thread_provider_sessions;

CREATE INDEX IF NOT EXISTS idx_thread_provider_sessions_thread
  ON thread_provider_sessions (thread_id);

CREATE INDEX IF NOT EXISTS idx_thread_provider_sessions_runtime
  ON thread_provider_sessions (runtime_id, provider);
