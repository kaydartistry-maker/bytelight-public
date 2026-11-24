import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeltContext } from './chat-tool-belt.js';
import { BuilderStore, activeStatuses, type BuilderJob } from './db/builder-jobs.js';
import { assertJobId, canonicalRoot, privateDirectory, processIdentity, matchesProcess, readEvents, redact, type ProcessIdentity } from './builder-job-io.js';
import { execution, identity, safeEnv, gitBytes } from './code-patch.js';

export interface BuilderConfig { root: string; workRoot: string; source: string; base: string; home: string; uid: number; gid: number; timeoutMs: number; production?: string; deploymentState?: string; }
export interface BuilderOwner { thread: string; session: string; audience: 'owner'; }
export function builderOwner(ctx?: BeltContext): BuilderOwner {
  // Explicit owner audience and trusted turn provenance; autonomous owner turns are allowed.
  if (ctx?.audience?.kind !== 'owner' || !ctx.threadId || !ctx.turnId) throw new Error('Trusted owner builder context required');
  return { thread: ctx.threadId, session: ctx.turnId, audience: 'owner' };
}
export function builderConfig(env = process.env): BuilderConfig {
  if (env.BYTELIGHT_BUILDER_ENABLED !== 'true') throw new Error('Builder is disabled');
  const id = identity('BYTELIGHT_CODEX');
  const root = resolve(env.BYTELIGHT_BUILDER_ROOT || '/var/lib/bytelight-builder/jobs');
  const workRoot = resolve(env.BYTELIGHT_BUILDER_WORK_ROOT || '/srv/bytelight-builder-jobs');
  const source = env.BYTELIGHT_BUILDER_SOURCE;
  const home = env.BYTELIGHT_CODEX_HOME;
  if (!source || !home) throw new Error('Explicit builder source and Codex HOME required');
  canonicalRoot(source); canonicalRoot(home);
  if (source === '/srv/bytelight-dev' || source.startsWith('/srv/bytelight-dev/')) throw new Error('Retired research workspace forbidden');
  const homeStat = statSync(home);
  if (homeStat.uid !== id.uid || homeStat.gid !== id.gid || (homeStat.mode & 0o077)) throw new Error('Codex HOME ownership/mode mismatch');
  const paths = [root, workRoot, source, home, env.BYTELIGHT_CODE_PRODUCTION || '/srv/bytelight-public'];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = resolve(paths[i]), b = resolve(paths[j]);
    if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new Error('Builder paths must be disjoint');
  }
  const timeoutMs = Number(env.BYTELIGHT_BUILDER_TIMEOUT_MS || 20 * 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60_000) throw new Error('Invalid builder runtime limit');
  const base = env.BYTELIGHT_BUILDER_BASE || 'HEAD';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,180}$/.test(base)) throw new Error('Invalid builder base ref');
  return { root, workRoot, source, home, base, ...id, timeoutMs, production: env.BYTELIGHT_CODE_PRODUCTION || '/srv/bytelight-public', deploymentState: env.BYTELIGHT_CODE_STATE_DIR || '/var/lib/bytelight-code' };
}
export function openBuilderStore(root: string): BuilderStore {
  privateDirectory(root);
  const path = join(root, 'builder.sqlite');
  if (existsSync(path)) { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.nlink !== 1) throw new Error('Unsafe builder database'); }
  const old = process.umask(0o077);
  try { return new BuilderStore(path); } finally { process.umask(old); }
}
export function builderGit(cfg: BuilderConfig, args: string[], cwd = cfg.source): string {
  const cmd = execution('/usr/bin/git', ['-c', `safe.directory=${cwd}`, ...args], cfg);
  return execFileSync(cmd.file, cmd.args, { cwd, env: safeEnv(cfg.home), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).toString().trim();
}
/** Dedicated deployed mode uses a bare repository, so a ref CAS never dirties a checkout. */
export function builderSourceDirty(cfg: BuilderConfig): boolean {
  return builderGit(cfg, ['rev-parse', '--is-bare-repository']) === 'true' ? false : !!builderGit(cfg, ['status', '--porcelain']);
}
export function assertBuilderBaseline(cfg: BuilderConfig, expected?: string, read = (cwd: string, args: string[]) => gitBytes(cwd, args).toString().trim()): void {
  // Generic fixture/development sources remain compatible; activation explicitly selects deployed.
  if (cfg.base !== 'deployed') return;
  if (!cfg.production || read(cfg.source, ['rev-parse', '--is-bare-repository']) !== 'true') throw new Error('BUILDER_BASELINE_BLOCKED: deployed mode requires a dedicated bare source and production path');
  const source = read(cfg.source, ['rev-parse', '--verify', 'refs/heads/deployed^{commit}']);
  const production = read(cfg.production, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (source !== production || (expected !== undefined && source !== expected)) throw new Error('BUILDER_BASELINE_MISMATCH: source deployed ref and production HEAD differ; inspect retained release state before starting work. No refs were reset.');
}
export function builderBaselineState(cfg: BuilderConfig): { status: 'ready' | 'blocked'; error?: string } {
  try { assertBuilderBaseline(cfg); return { status: 'ready' }; }
  catch (error) { return { status: 'blocked', error: redact(String(error)) }; }
}
export function requestPath(root: string, id: string): string { assertJobId(id); return join(root, id, 'request.json'); }
export function readRequest(root: string, id: string): { config: BuilderConfig; workerPath: string } {
  const path = requestPath(root, id); privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 8192) throw new Error('Unsafe builder request'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
export function expectedWorker(job: BuilderJob, workerPath: string): ProcessIdentity | null {
  if (!job.workerPid || !job.workerStarttime || !job.workerPgid) return null;
  // Exact argv check in addition to kernel start time. No model-provided command.
  try {
    const args = readFileSync(`/proc/${job.workerPid}/cmdline`).toString().split('\0').filter(Boolean);
    if (args.length !== 4 || args[0] !== process.execPath || args[1] !== workerPath || args[2] !== job.id || args[3] !== dirname(dirname(job.logPath))) return null;
    return { pid: job.workerPid, starttime: job.workerStarttime, pgid: job.workerPgid, commandHash: createHash('sha256').update(readFileSync(`/proc/${job.workerPid}/cmdline`)).digest('hex') };
  } catch { return null; }
}
export function liveOrphanedKeeper(store: BuilderStore, keeperPath: string, inspect = processIdentity): boolean {
  return store.orphaned().some(job => {
    if (!job.childPid || !job.childStarttime || job.childPgid !== job.childPid) return false;
    const actual = inspect(job.childPid);
    if (!actual || actual.starttime !== job.childStarttime || actual.pgid !== job.childPgid) return false;
    try {
      const argv = readFileSync(`/proc/${job.childPid}/cmdline`).toString().split('\0').filter(Boolean);
      return argv.length === 2 && argv[0] === process.execPath && argv[1] === keeperPath;
    } catch { return false; }
  });
}
export function reconcileJobs(store: BuilderStore, workerPath: string, now = Date.now(), live = (job: BuilderJob) => {
  const expected = expectedWorker(job, workerPath); return !!expected && matchesProcess(expected);
}): void {
  for (const job of store.active()) {
    // A start request may have committed queued metadata just before spawning.
    if (job.status === 'queued' && now - Date.parse(job.created) < 15_000) continue;
    if (live(job)) continue;
    store.update(job.id, { error: 'Worker missing or identity changed; workspace preserved. Inspect before starting replacement work.', currentPhase: 'orphaned', finished: new Date(now).toISOString() }, 'orphaned');
  }
}
export async function waitBuilderReady(store: BuilderStore, id: string, workerPath: string, timeout = 8000): Promise<BuilderJob> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const job = store.get(id)!;
    if (job.workerPid && job.started) {
      if (!activeStatuses.includes(job.status)) return job;
      const expected = expectedWorker(job, workerPath);
      if (expected && matchesProcess(expected)) return job;
    }
    if (!activeStatuses.includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('Builder readiness timed out; job retained for reconciliation');
}
export async function startBuilderJob(args: Record<string, unknown>, owner: BuilderOwner, cfg = builderConfig()): Promise<BuilderJob> {
  if (owner.audience !== 'owner' || !owner.thread || !owner.session) throw new Error('Owner required');
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task || task.length > 8000) throw new Error('Builder task must contain 1–8000 characters');
  if (args.mode !== undefined && !['edit', 'inspect'].includes(String(args.mode))) throw new Error('Invalid builder mode');
  const store = openBuilderStore(cfg.root);
  try {
    const workerPath = fileURLToPath(new URL('./builder-job-worker.js', import.meta.url));
    reconcileJobs(store, workerPath);
    if (liveOrphanedKeeper(store, fileURLToPath(new URL('./builder-job-process.js', import.meta.url)))) throw new Error('A prior builder is still stopping; retained workspace and process diagnostics require inspection');
    if (store.db.prepare("SELECT 1 FROM builder_deployments WHERE status IN ('preparing','deploying','rolling_back','recovery_required') LIMIT 1").get()) throw new Error('Builder release active or requires recovery; inspect retained state before starting work');
    if (cfg.base === 'deployed' && cfg.deploymentState && existsSync(join(cfg.deploymentState, 'deploy.lock'))) throw new Error('Shared deployment lock is held; finish deployment or inspect recovery state before starting work');
    assertBuilderBaseline(cfg);
    if (store.active().length) throw new Error('A builder job is already active; stop or finish it first');
    // The baseline may be this developer checkout, but never pending edits or drifting refs.
    if (builderSourceDirty(cfg)) throw new Error('Builder source is dirty; choose a clean baseline checkout');
    const baseCommit = builderGit(cfg, ['rev-parse', '--verify', `${cfg.base}^{commit}`]);
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error('Invalid builder baseline');
    const id = randomBytes(16).toString('hex');
    const slug = redact(task).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'task';
    const branch = `boss/${Date.now()}-${slug}-${id.slice(0, 8)}`;
    privateDirectory(join(cfg.root, id));
    const logPath = join(cfg.root, id, 'events.jsonl'); writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' });
    // Task is redacted before *any* durable write, including SQLite and the Codex prompt.
    store.insert({ id, ownerThread: owner.thread, ownerSession: owner.session, audience: 'owner', task: redact(task), mode: args.mode === 'inspect' ? 'inspect' : 'edit', workspace: join(cfg.workRoot, id), branch, baseCommit, logPath });
    writeFileSync(requestPath(cfg.root, id), JSON.stringify({ config: cfg, workerPath }), { mode: 0o600, flag: 'wx' });
    const launcher = spawn(process.execPath, [workerPath, '--launch', id, cfg.root], {
      cwd: '/', env: safeEnv('/nonexistent'), stdio: 'ignore', detached: true,
    });
    let launchError: Error | undefined;
    launcher.once('error', error => { launchError = error; }); launcher.unref();
    await new Promise<void>(resolvePromise => { launcher.once('exit', () => resolvePromise()); launcher.once('error', () => resolvePromise()); });
    if (launchError) { store.update(id, { error: redact(launchError.message), finished: new Date().toISOString() }, 'failed'); throw launchError; }
    return await waitBuilderReady(store, id, workerPath);
  } finally { store.close(); }
}
export function publicJob(job: BuilderJob, deployment?: object): object {
  const { ownerSession: _session, logPath: _log, ...rest } = job;
  return { ...rest, ...(deployment ? { deployment } : {}), changedFiles: JSON.parse(job.changedFiles) };
}
export async function builderAction(action: string, args: Record<string, unknown>, owner: BuilderOwner): Promise<object> {
  if (owner.audience !== 'owner' || !owner.thread || !owner.session) throw new Error('Owner required');
  if (['prepare_deploy', 'deploy', 'deploy_status', 'deploy_logs', 'rollback'].includes(action)) return (await import('./builder-deployment.js')).builderReleaseAction(action, args, owner);
  if (action === 'start') return publicJob(await startBuilderJob(args, owner));
  const cfg = builderConfig(), store = openBuilderStore(cfg.root);
  try {
    reconcileJobs(store, fileURLToPath(new URL('./builder-job-worker.js', import.meta.url)));
    if (action === 'list') return { baseline: builderBaselineState(cfg), jobs: store.list().map(job => publicJob(job, releaseSummary(store.deployment(job.id)))) };
    assertJobId(args.id); const job = store.get(args.id); if (!job) throw new Error('Builder job not found');
    if (action === 'status') return publicJob(job, releaseSummary(store.deployment(job.id)));
    if (action === 'logs') return readEvents(job.logPath, args.cursor === undefined ? 0 : Number(args.cursor));
    if (action === 'stop') {
      // Durable stop request, observed by detached worker. Never signal an unchecked PID here.
      if (job.status === 'running') store.update(job.id, { currentPhase: 'stopping' }, 'stopping');
      else if (job.status === 'queued') store.update(job.id, { finished: new Date().toISOString(), currentPhase: 'stopped' }, 'stopped');
      return publicJob(store.get(job.id)!);
    }
    throw new Error('Unknown builder action');
  } finally { store.close(); }
}
export async function builderTool(action: string, args: Record<string, unknown>, ctx?: BeltContext) {
  try { return { ok: true, result: JSON.stringify(await builderAction(action, args, builderOwner(ctx))) }; }
  catch (error) { return { ok: false, result: JSON.stringify({ error: redact(String(error)) }) }; }
}

export function reconcileBuilderReleases(store: BuilderStore, live = matchesProcess, now = Date.now()): void {
  for (const record of store.activeReleases()) {
    if (record.worker ? !live(record.worker) : now - Date.parse(record.updated) > 15_000)
      store.saveRelease({ ...record, status: 'recovery_required', error: 'Detached release worker missing or identity changed; retained state requires inspection.', updated: new Date(now).toISOString() });
  }
}

/** Boot reconciliation never stops a live detached worker or resumes uncertain work. */
export function initializeBuilderJobs(): void {
  if (process.env.BYTELIGHT_BUILDER_ENABLED !== 'true') return;
  const cfg = builderConfig(), store = openBuilderStore(cfg.root);
  try { reconcileJobs(store, fileURLToPath(new URL('./builder-job-worker.js', import.meta.url))); reconcileBuilderReleases(store); const baseline = builderBaselineState(cfg); if (baseline.status === 'blocked') console.warn(baseline.error); }
  finally { store.close(); }
}

function releaseSummary(record: import('./db/builder-jobs.js').ReleaseRecord | undefined): object | undefined { if (!record) return undefined; const { worker: _worker, ...summary } = record; return summary; }
