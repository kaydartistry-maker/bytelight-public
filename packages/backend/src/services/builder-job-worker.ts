/** Detached durable worker. Only the coding subprocess receives network/development tools. */
import { spawn, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BuilderStore } from './db/builder-jobs.js';
import { builderGit, builderSourceDirty, assertBuilderBaseline, openBuilderStore, readRequest, type BuilderConfig } from './builder-jobs.js';
import { BuilderOutput, appendEvent, assertJobId, canonicalRoot, matchesProcess, processIdentity, redact, signalGroup, type ProcessIdentity } from './builder-job-io.js';
import { safeEnv } from './code-patch.js';

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export async function waitForBuilderReparent(parent: number, current = () => process.ppid, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (parent !== 1 && current() === parent) { if (Date.now() >= end) throw new Error('Builder did not reparent'); await pause(20); }
}
export function groupMembers(pgid: number): ProcessIdentity[] {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name))).filter((p): p is ProcessIdentity => !!p && p.pgid === pgid);
}
export async function terminateBuilderGroup(expected: ProcessIdentity, grace = 1500): Promise<void> {
  if (!signalGroup(expected, 'SIGTERM')) throw new Error('Builder process identity changed; refusing signal');
  await pause(grace);
  if (!signalGroup(expected, 'SIGKILL')) throw new Error('Builder keeper identity changed before escalation');
  const end = Date.now() + 3000;
  while (groupMembers(expected.pgid).length) { if (Date.now() >= end) throw new Error('Builder process group did not quiesce'); await pause(25); }
}
export function prepareWorkspace(cfg: BuilderConfig, job: NonNullable<ReturnType<BuilderStore['get']>>): void {
  mkdirSync(cfg.workRoot, { recursive: true, mode: 0o755 });
  canonicalRoot(cfg.workRoot);
  const st = statSync(cfg.workRoot);
  if (st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error('Unsafe builder workspace parent');
  if (job.workspace !== join(cfg.workRoot, job.id) || existsSync(job.workspace)) throw new Error('Job workspace exists or mismatches');
  if (realpathSync(cfg.source) !== cfg.source || statSync(cfg.source).uid !== cfg.uid) throw new Error('Builder baseline must be physical and coder-owned');
  assertBuilderBaseline(cfg, job.baseCommit);
  if (builderSourceDirty(cfg) || builderGit(cfg, ['rev-parse', '--verify', `${cfg.base}^{commit}`]) !== job.baseCommit) throw new Error('Builder baseline changed before preparation');
  mkdirSync(job.workspace, { mode: 0o700 }); chownSync(job.workspace, cfg.uid, cfg.gid);
  // Worktrees share only Git administration. No production configuration/data are copied.
  builderGit(cfg, ['worktree', 'add', '-b', job.branch, job.workspace, job.baseCommit]);
  if (builderGit(cfg, ['rev-parse', 'HEAD'], job.workspace) !== job.baseCommit) throw new Error('Prepared worktree baseline mismatch');
}
export function specialistArgs(task: string, mode: 'inspect' | 'edit'): string[] {
  const prompt = [
    'You are BL Companion A’s trusted development specialist. Complete this development task autonomously.',
    mode === 'inspect' ? 'READ ONLY: inspect and report. Do not edit, install, build, commit, or leave processes running.' : 'You may edit source, install ordinary dependencies using network access, run tests/builds, and create local commits in this job workspace.',
    'Stay inside this job workspace. Preserve existing work. Do not push, deploy, restart production, or change Git remotes.',
    'Never read or modify production paths, .env, bytelight.yaml, data/, memory-vault/, credentials, SSH material, or secrets. Do not change OS/root settings, spend money, or connect accounts.',
    'If the task requires an exceptional action, stop and explain what owner approval is needed. No per-file approval is needed for ordinary development.',
    'Do not leave background servers or child processes running. End with changed files, validation and remaining concerns.',
    `Task: ${task}`,
  ].join('\n');
  return ['exec', '--ephemeral', '--color', 'never', ...(mode === 'inspect' ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']), '--cd', '.', prompt];
}
export interface BuilderWorkerIO { prepare?: typeof prepareWorkspace; spawnKeeper?: () => ChildProcess; self?: () => ProcessIdentity | null; }
export async function runBuilderWorker(id: string, root: string, io: BuilderWorkerIO = {}): Promise<void> {
  assertJobId(id); const { config: cfg } = readRequest(root, id);
  if (cfg.root !== root) throw new Error('Builder root mismatch');
  const store = openBuilderStore(root);
  let keeper: ChildProcess | undefined, group: ProcessIdentity | undefined, cleaned = false;
  let outcome: 'succeeded' | 'failed' | 'stopped' = 'failed', failure: string | undefined, output = '', tail = '';
  let logFailure: Error | undefined;
  const event = (type: string, text: string) => {
    if (logFailure) return;
    try { store.update(id, { logCursor: appendEvent(store.get(id)!.logPath, type, text) }); }
    catch (error) { logFailure = error instanceof Error ? error : new Error(String(error)); }
  };
  const captureLine = (line: string) => { event('output', line); output = (output + line + '\n').slice(-24000); };
  const streams = { stdout: new BuilderOutput(captureLine), stderr: new BuilderOutput(captureLine) };
  try {
    const job = store.get(id); if (!job) throw new Error('Builder job missing');
    store.db.transaction(() => {
      const current = store.get(id)!;
      if (current.status !== 'queued' || current.workerPid) throw new Error('Builder job already claimed or stopped');
      const self = io.self ? io.self() : processIdentity(process.pid); if (!self || self.pgid !== process.pid) throw new Error('Builder worker must be detached group leader');
      store.update(id, { workerPid: self.pid, workerStarttime: self.starttime, workerPgid: self.pgid, currentPhase: 'preparing', started: new Date().toISOString() }, 'running');
    })();
    event('phase', 'Preparing isolated worktree');
    (io.prepare || prepareWorkspace)(cfg, job);
    if (store.get(id)!.status === 'stopping') { outcome = 'stopped'; return; }
    store.update(id, { currentPhase: 'coding', command: 'codex exec' });
    keeper = io.spawnKeeper ? io.spawnKeeper() : spawn(process.execPath, [fileURLToPath(new URL('./builder-job-process.js', import.meta.url))], {
      detached: true, cwd: '/', env: safeEnv('/nonexistent'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await new Promise<void>((resolvePromise, reject) => { keeper!.once('spawn', () => resolvePromise()); keeper!.once('error', reject); });
    group = processIdentity(keeper.pid! ) || undefined; if (!group || group.pgid !== group.pid) throw new Error('Missing builder group identity');
    store.update(id, { childPid: group.pid, childStarttime: group.starttime, childPgid: group.pgid });
    let done: { code: number | null; error?: string } | undefined, exited = false;
    keeper.once('exit', () => { exited = true; });
    keeper.on('message', (raw: unknown) => {
      const message = raw as { type?: string; text?: string; stream?: string; code?: number | null; error?: string };
      if (message.type === 'output' && typeof message.text === 'string') streams[message.stream === 'stderr' ? 'stderr' : 'stdout'].write(message.text);
      if (message.type === 'done') done = { code: message.code ?? null, error: message.error };
    });
    const commonGit = realpathSync(builderGit(cfg, ['rev-parse', '--git-common-dir'], job.workspace).startsWith('/')
      ? builderGit(cfg, ['rev-parse', '--git-common-dir'], job.workspace)
      : join(job.workspace, builderGit(cfg, ['rev-parse', '--git-common-dir'], job.workspace)));
    keeper.send({ args: specialistArgs(job.task, job.mode), cwd: job.workspace, commonGit, home: cfg.home, uid: cfg.uid, gid: cfg.gid });
    const deadline = Date.now() + cfg.timeoutMs;
    while (!done) {
      if (store.get(id)!.status === 'stopping') { outcome = 'stopped'; break; }
      if (logFailure) throw logFailure;
      if (Date.now() > deadline) throw new Error('Builder runtime limit reached');
      if (exited || !matchesProcess(group)) throw new Error('Builder keeper exited unexpectedly');
      await pause(100);
    }
    if (outcome !== 'stopped') {
      if (done?.code !== 0) throw new Error(done?.error || `Codex exited with ${done?.code}`);
      outcome = 'succeeded';
    }
  } catch (error) { failure = redact(String(error)); }
  finally {
    try {
      if (group) { await terminateBuilderGroup(group); cleaned = true; }
      else if (!keeper) cleaned = true;
      else throw new Error('Builder launched without verifiable identity');
    } catch (error) { failure = `${failure || ''} Cleanup uncertain: ${redact(String(error))}`; outcome = 'failed'; }
    streams.stdout.write('', true); streams.stderr.write('', true);
    let changedFiles: string[] = [];
    const job = store.get(id);
    if (job?.workerPid === process.pid) {
      try {
        if (existsSync(join(job.workspace, '.git'))) {
          const changed = builderGit(cfg, ['diff', '--name-only', '-z', job.baseCommit, '--'], job.workspace).split('\0');
          const untracked = builderGit(cfg, ['ls-files', '--others', '--exclude-standard', '-z'], job.workspace).split('\0');
          changedFiles = [...new Set([...changed, ...untracked].filter(Boolean))].slice(0, 1000).map(name => redact(name));
        }
      } catch (error) { failure = `${failure || ''} Change report: ${redact(String(error))}`; }
      if (logFailure) { failure = logFailure.message; outcome = 'failed'; }
      if (store.get(id)!.status === 'stopping' && cleaned) outcome = 'stopped';
      if (failure && outcome !== 'stopped') outcome = 'failed';
      event('phase', `${outcome}; workspace retained`);
      if (logFailure) { failure = logFailure.message; outcome = 'failed'; }
      store.update(id, { currentPhase: cleaned ? outcome : 'cleanup-uncertain', report: output, changedFiles: JSON.stringify(changedFiles), error: failure || null, finished: new Date().toISOString() }, cleaned ? outcome : 'orphaned');
    }
    store.close();
  }
}
const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv[2] === '--launch') {
    assertJobId(process.argv[3]); const root = canonicalRoot(process.argv[4]);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), process.argv[3], root], { detached: true, cwd: '/', env: safeEnv('/nonexistent'), stdio: 'ignore' });
    child.once('error', () => { process.exitCode = 1; }); child.unref();
  } else {
    const parent = process.ppid;
    void waitForBuilderReparent(parent).then(() => runBuilderWorker(process.argv[2], process.argv[3])).catch(() => { process.exitCode = 1; });
  }
}
