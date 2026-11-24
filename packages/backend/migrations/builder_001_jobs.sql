-- Dedicated builder metadata DB. Never applied to the companion/content DB.
CREATE TABLE IF NOT EXISTS builder_jobs (
 id TEXT PRIMARY KEY, ownerThread TEXT NOT NULL, ownerSession TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience = 'owner'), task TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('edit','inspect')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','succeeded','failed','stopped','orphaned')),
 workspace TEXT NOT NULL, branch TEXT NOT NULL, baseCommit TEXT NOT NULL,
 workerPid INTEGER, workerStarttime TEXT, workerPgid INTEGER,
 childPid INTEGER, childStarttime TEXT, childPgid INTEGER,
 currentPhase TEXT NOT NULL DEFAULT 'queued', command TEXT,
 changedFiles TEXT NOT NULL DEFAULT '[]', report TEXT, error TEXT,
 logPath TEXT NOT NULL, logCursor INTEGER NOT NULL DEFAULT 0,
 created TEXT NOT NULL, updated TEXT NOT NULL, started TEXT, finished TEXT
);
CREATE INDEX IF NOT EXISTS builder_jobs_owner_created ON builder_jobs(ownerThread, created DESC);
CREATE INDEX IF NOT EXISTS builder_jobs_status ON builder_jobs(status, updated);
-- Initially reject concurrent work, rather than silently queueing without a scheduler.
CREATE UNIQUE INDEX IF NOT EXISTS builder_jobs_one_active ON builder_jobs((1))
 WHERE status IN ('queued','running','stopping');
