import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type BuilderStatus = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'orphaned';
export interface BuilderJob {
  id: string; ownerThread: string; ownerSession: string; audience: 'owner'; task: string; mode: 'edit' | 'inspect'; status: BuilderStatus;
  workspace: string; branch: string; baseCommit: string;
  workerPid: number | null; workerStarttime: string | null; workerPgid: number | null;
  childPid: number | null; childStarttime: string | null; childPgid: number | null;
  currentPhase: string; command: string | null; changedFiles: string; report: string | null; error: string | null;
  logPath: string; logCursor: number; created: string; updated: string; started: string | null; finished: string | null;
}
export const activeStatuses: BuilderStatus[] = ['queued', 'running', 'stopping'];
const transitions: Record<BuilderStatus, BuilderStatus[]> = {
  queued: ['running', 'stopped', 'failed', 'orphaned'], running: ['stopping', 'succeeded', 'failed', 'stopped', 'orphaned'],
  stopping: ['stopped', 'failed', 'orphaned'], succeeded: [], failed: [], stopped: [], orphaned: [],
};
const mutable = new Set(['workerPid', 'workerStarttime', 'workerPgid', 'childPid', 'childStarttime', 'childPgid', 'currentPhase', 'command', 'changedFiles', 'report', 'error', 'logCursor', 'started', 'finished']);
export class BuilderStore {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(readFileSync(fileURLToPath(new URL('../../../migrations/builder_001_jobs.sql', import.meta.url)), 'utf8'));
    this.db.exec(readFileSync(fileURLToPath(new URL('../../../migrations/builder_002_deployments.sql', import.meta.url)), 'utf8'));
  }
  get(id: string): BuilderJob | undefined { return this.db.prepare('SELECT * FROM builder_jobs WHERE id = ?').get(id) as BuilderJob | undefined; }
  list(limit = 100): BuilderJob[] { return this.db.prepare('SELECT * FROM builder_jobs ORDER BY created DESC LIMIT ?').all(limit) as BuilderJob[]; }
  orphaned(): BuilderJob[] { return this.db.prepare("SELECT * FROM builder_jobs WHERE status = 'orphaned' AND childPid IS NOT NULL").all() as BuilderJob[]; }
  active(): BuilderJob[] { return this.db.prepare("SELECT * FROM builder_jobs WHERE status IN ('queued','running','stopping')").all() as BuilderJob[]; }
  insert(job: Pick<BuilderJob, 'id' | 'ownerThread' | 'ownerSession' | 'audience' | 'task' | 'mode' | 'workspace' | 'branch' | 'baseCommit' | 'logPath'>): BuilderJob {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO builder_jobs (id,ownerThread,ownerSession,audience,task,mode,workspace,branch,baseCommit,logPath,status,created,updated)
      VALUES (@id,@ownerThread,@ownerSession,@audience,@task,@mode,@workspace,@branch,@baseCommit,@logPath,'queued',@now,@now)`).run({ ...job, now });
    return this.get(job.id)!;
  }
  update(id: string, patch: Partial<BuilderJob>, status?: BuilderStatus): BuilderJob {
    return this.db.transaction(() => {
      const before = this.get(id); if (!before) throw new Error('Builder job not found');
      if (status && status !== before.status && !transitions[before.status].includes(status)) throw new Error(`Invalid builder transition: ${before.status} -> ${status}`);
      const entries = Object.entries(patch); if (entries.some(([k]) => !mutable.has(k))) throw new Error('Immutable builder field');
      const values: Record<string, unknown> = Object.fromEntries(entries);
      values.updated = new Date().toISOString(); if (status) values.status = status;
      const columns = Object.keys(values);
      this.db.prepare(`UPDATE builder_jobs SET ${columns.map(k => `${k} = @${k}`).join(',')} WHERE id = @id`).run({ ...values, id });
      return this.get(id)!;
    })();
  }
  activeReleases(): ReleaseRecord[] {
    return (this.db.prepare("SELECT data FROM builder_deployments WHERE status IN ('preparing','deploying','rolling_back')").all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  deployment(jobId: string): ReleaseRecord | undefined {
    const row = this.db.prepare('SELECT data FROM builder_deployments WHERE jobId = ? ORDER BY rowid DESC LIMIT 1').get(jobId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  release(id: string): ReleaseRecord | undefined {
    const row = this.db.prepare('SELECT data FROM builder_deployments WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveRelease(value: ReleaseRecord): void {
    this.db.prepare(`INSERT INTO builder_deployments(id,jobId,status,data,created,updated) VALUES (@id,@jobId,@status,@data,@created,@updated)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated=excluded.updated`).run({ ...value, data: JSON.stringify(value) });
  }
  close(): void { this.db.close(); }
}

export interface ReleaseRecord {
  id: string; jobId: string; status: 'preparing' | 'prepared' | 'deploying' | 'deployed' | 'rolling_back' | 'rolled_back' | 'failed' | 'recovery_required';
  commit: string; base: string; tree: string; phase: string; created: string; updated: string;
  worker?: import('../builder-job-io.js').ProcessIdentity; error?: string; reason?: string;
  metrics?: Partial<Record<'prepare' | 'deploy' | 'rollback', Record<string, number>>>;
  dependencyCache?: { key: string; hit: boolean; bytes?: number };
  pm2Identity?: string; bundleSha256?: string;
  ciImport?: import('../builder-release-ci.js').CIPin;
  rollback?: string; database?: string; health?: { pid: number; restarts: number };
}
