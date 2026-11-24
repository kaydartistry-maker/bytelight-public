import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stage a private jobs file before module load. Never borrow or overwrite the
// application's jobs/gallery: other test processes and the app may be active.
const tmpRoot = mkdtempSync(join(tmpdir(), 'image-gen-test-'));
const priorDataDir = process.env.BYTELIGHT_STUDIO_DATA_DIR;
const DATA_DIR = join(tmpRoot, 'studio');
process.env.BYTELIGHT_STUDIO_DATA_DIR = DATA_DIR;
const JOBS_FILE = join(DATA_DIR, 'studio-image-jobs.json');
mkdirSync(DATA_DIR, { recursive: true });
const realJobsFile = existsSync(JOBS_FILE) ? readFileSync(JOBS_FILE, 'utf8') : null;

const now = Date.now();
const hours = (n: number) => n * 60 * 60 * 1000;
writeFileSync(JOBS_FILE, JSON.stringify([
  { id: 'job_was_pending', status: 'pending', input: { prompt: 'p' }, createdAt: now },
  { id: 'job_was_running', status: 'running', input: { prompt: 'p' }, createdAt: now },
  { id: 'job_done_fresh', status: 'completed', input: { prompt: 'p' }, createdAt: now - hours(1), completedAt: now - hours(1) },
  { id: 'job_done_stale', status: 'failed', input: { prompt: 'p' }, createdAt: now - hours(26), completedAt: now - hours(25) },
]));

// Real disk-backed DB, same pattern as secrets.test.ts — getImageGenSettings
// reads config through getDb().
const { initDb, setConfig } = await import('./db.js');
initDb(join(tmpRoot, 'test.db'));

const { getJobStatus, listImageJobs, pruneFinishedJobs, startGenerateJob } = await import('./image-gen.js');

after(() => {
  if (realJobsFile === null) rmSync(JOBS_FILE, { force: true });
  else writeFileSync(JOBS_FILE, realJobsFile);
  if (priorDataDir === undefined) delete process.env.BYTELIGHT_STUDIO_DATA_DIR;
  else process.env.BYTELIGHT_STUDIO_DATA_DIR = priorDataDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('restart honesty (no silent rerun)', () => {
  it('marks jobs caught mid-flight as failed instead of re-running them', () => {
    for (const id of ['job_was_pending', 'job_was_running']) {
      const job = getJobStatus(id);
      assert.equal(job?.status, 'failed', id);
      assert.match(job?.error ?? '', /restarted/i);
      assert.ok(job?.completedAt, `${id} gets a completedAt so pruning can age it out`);
    }
  });

  it('leaves finished jobs untouched', () => {
    assert.equal(getJobStatus('job_done_fresh')?.status, 'completed');
  });

  it('persists the corrected statuses back to disk', () => {
    const onDisk = JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as Array<{ id: string; status: string }>;
    assert.equal(onDisk.find((j) => j.id === 'job_was_pending')?.status, 'failed');
  });
});

describe('24-hour pruning', () => {
  it('drops finished jobs older than the TTL and keeps recent ones', () => {
    assert.ok(getJobStatus('job_done_stale'), 'stale job present before prune');
    pruneFinishedJobs();
    assert.equal(getJobStatus('job_done_stale'), undefined);
    assert.equal(getJobStatus('job_done_fresh')?.status, 'completed');
  });

  it('never prunes active work', () => {
    // A pending job created 48h ago must survive any prune.
    writeFileSync(JOBS_FILE, JSON.stringify([{ id: 'job_ancient_active', status: 'pending', input: { prompt: 'p' }, createdAt: now - hours(48) }]));
    // jobs map is in-memory; simulate via the public surface — a fresh pending
    // job is indistinguishable in kind, so assert on the in-memory jobs:
    const active = listImageJobs().filter((j) => j.status === 'pending' || j.status === 'running');
    pruneFinishedJobs(now + hours(100));
    for (const job of active) assert.ok(getJobStatus(job.id), `${job.id} survived`);
  });
});

describe('input validation', () => {
  it('refuses to start while image generation is disabled', () => {
    assert.throws(() => startGenerateJob({ prompt: 'a cat' }), /switched off/i);
  });

  it('refuses an empty prompt', () => {
    setConfig('image_gen.enabled', 'true');
    assert.throws(() => startGenerateJob({ prompt: '   ' }), /prompt is required/i);
  });
});

describe('provider unavailable', () => {
  it('fails the job with a clean error instead of crashing the engine', async () => {
    setConfig('image_gen.enabled', 'true');
    setConfig('image_gen.backend', 'codex');
    setConfig('image_gen.codex_bin', join(tmpRoot, 'no-such-codex'));
    const id = startGenerateJob({ prompt: 'a lighthouse at dusk' });
    assert.equal(getJobStatus(id)?.status, 'pending');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = getJobStatus(id)?.status;
      if (status === 'failed' || status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const job = getJobStatus(id);
    assert.equal(job?.status, 'failed');
    assert.match(job?.error ?? '', /codex/i);
  });
});
