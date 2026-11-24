-- Durable links to detached release preparation, deployment and rollback.
CREATE TABLE IF NOT EXISTS builder_deployments (
 id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES builder_jobs(id),
 status TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS builder_deployments_job ON builder_deployments(jobId, created DESC);
CREATE UNIQUE INDEX IF NOT EXISTS builder_deployments_one_worker ON builder_deployments((1))
 WHERE status IN ('preparing','deploying','rolling_back','recovery_required');
