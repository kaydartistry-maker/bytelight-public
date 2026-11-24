/** Privileged coordinator. No model-controlled command, executable or filesystem path. */
import { spawn, execFileSync, type SpawnOptions } from 'node:child_process';
import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, existsSync, chownSync, readdirSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeltContext } from './chat-tool-belt.js';
import { bindAuthorization, digest, freshApproval, liveOwner, type Authorization } from './code-authorization.js';
import { finalizeCheckpoint } from './code-checkpoint.js';
import { pendingPatch, gitBytes, identity, safeEnv, execution } from './code-patch.js';
export type ApprovalContext = BeltContext;
export function approved(ctx?: ApprovalContext, authorization?: Authorization, unresolvedCount = 0): boolean {
  return !!authorization && freshApproval(ctx, authorization, unresolvedCount);
}
export function bindPendingAuthorization(ctx: BeltContext | undefined, branch: string, head: string, snap: ReturnType<typeof pendingPatch>) {
  const dir = stateDir(true);
  const auth = bindAuthorization(ctx, branch, head, snap, existsSync(join(dir, `${digest(branch)}.failed`)));
  writeFileSync(join(dir, `${auth.authorization_id}.authorization`), JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
  if (!existsSync(join(dir, `${snap.diff_sha256}.request`))) atomic(join(dir, `${snap.diff_sha256}.json`), { status: 'editing', lifecycle: 'Editing', branch, diff_sha256: snap.diff_sha256, authorization_id: auth.authorization_id, reasons: auth.reasons, requires_fresh_approval: auth.requires_fresh_approval });
  return auth;
}
/** Computed only from root-owned durable state; never supplied by a tool. */
function unresolvedAuthorizations(dir: string, threadId: string): number {
  return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.authorization$/.test(name)).map(name => JSON.parse(trustedFileBytes(join(dir, name)).toString()) as Authorization).filter(auth => {
    if (auth.threadId !== threadId) return false;
    const resultPath = join(dir, `${auth.diff_sha256}.json`);
    if (!existsSync(resultPath)) return true;
    const result = JSON.parse(trustedFileBytes(resultPath).toString());
    return !['deployed', 'rolled_back'].includes(result.status);
  }).length;
}
/** Transport delivery aliases bind external reply IDs to the exact internal stream. */
export function bindDeliveredProposal(threadId: string, proposalMessageId: string | undefined, deliveredMessageId: string): void {
  if (!proposalMessageId || process.getuid?.() !== 0) return;
  const dir = stateDir(true);
  writeFileSync(join(dir, `${digest(deliveredMessageId)}.proposal`), JSON.stringify({ threadId, proposalMessageId, deliveredMessageId }), { mode: 0o600, flag: 'wx' });
}
function approvalReplyContext(ctx: BeltContext, dir: string): BeltContext {
  if (!ctx.replyToMessageId) return ctx;
  const path = join(dir, `${digest(ctx.replyToMessageId)}.proposal`);
  if (!existsSync(path)) return ctx;
  const link = JSON.parse(trustedFileBytes(path).toString());
  return deliveredProposalContext(ctx, link);
}
export function deliveredProposalContext(ctx: BeltContext, link: { threadId: string; deliveredMessageId: string; proposalMessageId: string }): BeltContext {
  if (link.threadId !== ctx.threadId || link.deliveredMessageId !== ctx.replyToMessageId || !link.proposalMessageId || typeof link.proposalMessageId !== 'string') throw new Error('Proposal delivery binding mismatch');
  return { ...ctx, replyToMessageId: link.proposalMessageId };
}
const reply = (value: object, ok = true) => ({ ok, result: JSON.stringify(value) });
function requestKey(branch: unknown, hash: unknown) {
  if (typeof branch !== 'string' || !/^codex\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(branch)) throw new Error('Invalid codex branch');
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid diff_sha256');
  return hash;
}
function trustedDirectory(path: string): void {
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    if (st.isSymbolicLink() || st.uid !== 0 || ((st.mode & 0o022) && !(st.mode & 0o1000))) throw new Error('Privileged directory ancestry is writable or untrusted');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function stateDir(create = false) {
  const path = process.env.BYTELIGHT_CODE_STATE_DIR || '/var/lib/bytelight-code';
  if (!path.startsWith('/') || resolve(path) !== path) throw new Error('Absolute canonical state directory required');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  trustedDirectory(path);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new Error('State directory must be root-owned 0700 without symlinks');
  return path;
}
function atomic(path: string, value: object) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
}
export async function deployCodeStatus(args: Record<string, unknown>) {
  try {
    const key = requestKey(args.branch, args.diff_sha256);
    const value = JSON.parse(readFileSync(join(stateDir(), `${key}.json`), 'utf8'));
    if (value.branch !== args.branch) throw new Error('Branch mismatch');
    if (value.status === 'pending') {
      try {
        const lock = JSON.parse(readFileSync(join(stateDir(), 'deploy.lock'), 'utf8'));
        let alive = false;
        if (Number.isInteger(lock.pid) && lock.pid > 0) { try { process.kill(lock.pid, 0); alive = true; } catch {} }
        value.worker = { ...lock, alive };
        if (!alive) value.next = 'Worker is not running. Administrator must inspect the request, backup, source, artifacts and database before recovering this lock. Do not blindly remove it.';
      } catch { value.next = 'Pending result has no readable lock; administrator inspection required.'; }
    }
    return reply(value);
  } catch (e) { return reply({ error: String(e) }, false); }
}
export async function deployCode(args: Record<string, unknown>, ctx?: ApprovalContext) {
  if (!liveOwner(ctx)) return reply({ error: 'Live owner deployment approval required' }, false);
  try {
    const key = requestKey(args.branch, args.diff_sha256);
    if (process.env.BYTELIGHT_CODE_DEPLOYMENT_ENABLED !== 'true') throw new Error('Code deployment is disabled by the owner');
    if (process.getuid?.() !== 0) throw new Error('Root coordinator required');
    const cfg = configuration();
    if (gitBytes(cfg.dev, ['rev-parse', '--show-toplevel']).toString().trim() !== cfg.dev || gitBytes(cfg.prod, ['rev-parse', '--show-toplevel']).toString().trim() !== cfg.prod) throw new Error('Git workspace root mismatch');
    const snapshot = pendingPatch(cfg.dev);
    if (gitBytes(cfg.dev, ['branch', '--show-current']).toString().trim() !== args.branch || snapshot.diff_sha256 !== key) throw new Error('Branch/fingerprint mismatch');
    validateFiles(snapshot.files);
    const dir = stateDir(true);
    if (typeof args.authorization_id !== 'string' || !/^[a-f0-9]{64}$/.test(args.authorization_id)) throw new Error('Bound authorization required');
    const auth: Authorization = JSON.parse(readFileSync(join(dir, `${args.authorization_id}.authorization`), 'utf8'));
    if (auth.authorization_id !== args.authorization_id || auth.branch !== args.branch || auth.diff_sha256 !== key || auth.head !== gitBytes(cfg.dev, ['rev-parse', 'HEAD']).toString().trim() || JSON.stringify(auth.files) !== JSON.stringify(snapshot.files)) throw new Error('Authorization binding mismatch');
    const policy = bindAuthorization(ctx, auth.branch, auth.head, snapshot, existsSync(join(dir, `${digest(auth.branch)}.failed`)));
    const standing = !!ctx!.turnId && auth.origin_message_id === ctx!.ownerMessageId && auth.proposal_message_id === ctx!.proposalMessageId && auth.origin_turn_id === ctx!.turnId && !auth.requires_fresh_approval && !policy.requires_fresh_approval && auth.threadId === ctx!.threadId && auth.origin_digest === digest(ctx!.rawOwnerMessageText!);
    if (!standing && !freshApproval(approvalReplyContext(ctx!, dir), auth, unresolvedAuthorizations(dir, auth.threadId))) throw new Error('Later live owner approval of bound pending change required');
    if (existsSync(join(dir, `${key}.request`))) {
      try {
        const durable = JSON.parse(trustedFileBytes(join(dir, `${key}.request`)).toString());
        if (!trustedFileBytes(join(dir, `${key}.patch`)).equals(snapshot.patch) || durable.branch !== auth.branch || durable.tree !== snapshot.tree || durable.authorization_id !== auth.authorization_id || durable.diff_sha256 !== key || durable.head !== auth.head || JSON.stringify(durable.files) !== JSON.stringify(snapshot.files)) throw new Error('Recovery Required: incoherent immutable request');
        const previous = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
        if (!['pending', 'deployed', 'failed', 'rolled_back', 'recovery_required'].includes(previous.status) || previous.branch !== args.branch || previous.diff_sha256 !== key) throw new Error('Recovery Required: existing request result mismatch');
        if (previous.status === 'pending' || previous.status === 'recovery_required') {
          const durableLock = JSON.parse(trustedFileBytes(join(dir, 'deploy.lock')).toString());
          if (durableLock.key !== key) throw new Error('Recovery Required: request lock mismatch');
        }
        return reply({ ...previous, next: 'This fingerprint already has a request. Read deploy_code_status; never replay it.' });
      } catch (error) { throw new Error(`Recovery Required: incoherent durable request association: ${String(error)}`); }
    }
    if (existsSync(join(dir, `${key}.patch`))) {
      let same = false;
      try { same = trustedFileBytes(join(dir, `${key}.patch`)).equals(snapshot.patch); } catch {}
      atomic(join(dir, `${key}.json`), { status: 'recovery_required', lifecycle: 'Recovery Required', branch: args.branch, diff_sha256: key, error: same ? 'Orphaned immutable patch' : 'Immutable patch mismatch or unsafe file' });
      throw new Error(`Recovery Required: ${same ? 'orphaned immutable patch without durable request' : 'immutable patch mismatch'}`);
    }
    const lock = join(dir, 'deploy.lock');
    // A lock is deliberately never auto-unlinked: a dead coordinator may have a live worker or touched production.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, state: 'starting', key }), { flag: 'wx', mode: 0o600 });
    try {
      atomic(join(dir, `${digest(String(args.branch))}.failed`), { key, reason: 'deployment incomplete' });
      createImmutablePatch(dir, key, snapshot.patch);
      atomic(join(dir, `${key}.request`), { branch: args.branch, diff_sha256: key, head: auth.head, tree: snapshot.tree, files: snapshot.files, authorization_id: auth.authorization_id });
      atomic(join(dir, `${key}.json`), { status: 'pending', lifecycle: 'Validating', branch: args.branch, diff_sha256: key });
      const worker = fileURLToPath(new URL('./code-deployment-worker.js', import.meta.url));
      trustedDirectory(dirname(worker));
      const workerStat = lstatSync(worker);
      if (!workerStat.isFile() || workerStat.uid !== 0 || (workerStat.mode & 0o022)) throw new Error('Worker must be trusted root-owned compiled code');
      await startDetachedWorker(worker, key, dir);
      // Worker records its own PID; a fast worker must not race a parent lock rewrite.
    } catch (e) { const recovery = existsSync(join(dir, `${key}.patch`)); atomic(join(dir, `${key}.json`), { status: recovery ? 'recovery_required' : 'failed', lifecycle: recovery ? 'Recovery Required' : 'Failed', branch: args.branch, diff_sha256: key, error: String(e) }); atomic(join(dir, `${digest(String(args.branch))}.failed`), { key }); if (!recovery) cleanStartingLock(dir, key); if (recovery) throw new Error(`Recovery Required: incomplete immutable request: ${String(e)}`); throw e; }
    return reply({ status: 'pending', lifecycle: 'Validating', branch: args.branch, diff_sha256: key, next: 'Read deploy_code_status on the next turn.' });
  } catch (e) { return reply({ error: String(e) }, false); }
}
/** Never overwrite crash material, including a byte-identical orphan. */
export function createImmutablePatch(dir: string, key: string, patch: Buffer): void {
  try { writeFileSync(join(dir, `${key}.patch`), patch, { mode: 0o600, flag: 'wx' }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let same = false;
    try { same = trustedFileBytes(join(dir, `${key}.patch`)).equals(patch); }
    catch (error) { throw new Error(`Recovery Required: unreadable immutable patch: ${String(error)}`); }
    throw new Error(`Recovery Required: immutable patch ${same ? 'already exists; inspect durable association' : 'mismatch'}`);
  }
}
export function cleanStartingLock(dir: string, key: string) {
  const path = join(dir, 'deploy.lock');
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (lock.key === key && lock.state === 'starting' && lock.pid === process.pid) rmSync(path);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export function workerReady(key: string, dir = stateDir()) {
  if (!/^[a-f0-9]{64}$/.test(key) || process.getuid?.() !== 0) throw new Error('Invalid ready worker');
  const lock = JSON.parse(readFileSync(join(dir, 'deploy.lock'), 'utf8'));
  if (lock.key !== key || lock.state !== 'starting') throw new Error('Worker starting lock mismatch');
  atomic(join(dir, `${key}.ready`), { key, pid: process.pid });
}
export async function startDetachedWorker(worker: string, key: string, dir: string,
  start: (file: string, args: string[], options: SpawnOptions) => { once(event: string, listener: (...args: any[]) => void): unknown; unref(): void } = spawn,
  timeoutMs = 5000, launch?: { args: string[]; env: NodeJS.ProcessEnv }) {
  let failure: unknown;
  const child = start(process.execPath, [worker, ...(launch?.args || ['--launch', key])], { detached: true, stdio: 'ignore', env: launch?.env || workerEnv(), cwd: dir });
  // Install both listeners immediately; an early exit must not race a later listener.
  child.once('error', e => { failure = e; });
  child.once('exit', code => { if (code !== 0) failure = new Error('Worker bootstrap failed'); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (failure) throw failure;
    const ready = join(dir, `${key}.ready`);
    if (existsSync(ready)) {
      const fd = openSync(ready, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o077) || st.size > 1024) throw new Error('Unsafe worker handshake');
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        if (value.key !== key || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid === process.pid) throw new Error('Invalid worker handshake');
      } finally { closeSync(fd); }
      return;
    }
    const result = join(dir, `${key}.json`);
    if (existsSync(result) && JSON.parse(readFileSync(result, 'utf8')).status === 'failed') throw new Error('Worker failed before ready');
    if (Date.now() >= deadline) throw new Error('Worker ready handshake timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
export async function waitForReparent(parent: number, current = () => process.ppid, pause = () => new Promise<void>(r => setTimeout(r, 20))) {
  const deadline = Date.now() + 5000;
  while (parent !== 1 && current() === parent) {
    if (Date.now() >= deadline) throw new Error('Worker did not detach from launcher');
    await pause();
  }
}
export function workerEnv() {
  const env = safeEnv();
  for (const name of ['WORKSPACE', 'PRODUCTION', 'STATE_DIR', 'STAGING_DIR', 'BACKUP_DIR', 'HEALTH_URL', 'PM2_APP', 'SQLITE_PATH']) {
    const k = `BYTELIGHT_CODE_${name}`; if (process.env[k]) env[k] = process.env[k];
  }
  for (const k of ['BYTELIGHT_BUILD_UID', 'BYTELIGHT_BUILD_GID', 'BYTELIGHT_CODEX_UID', 'BYTELIGHT_CODEX_GID']) env[k] = process.env[k];
  return env;
}
export function configuration(workspace?: string) {
  const get = (name: string) => { const p = process.env[`BYTELIGHT_CODE_${name}`]; if (!p || !p.startsWith('/') || resolve(p) !== p || realpathSync(p) !== p) throw new Error(`Canonical existing ${name} required`); return p; };
  const dev = workspace || get('WORKSPACE'), prod = get('PRODUCTION'), staging = get('STAGING_DIR'), backup = get('BACKUP_DIR'), state = stateDir();
  const paths = [dev, prod, staging, backup, state];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + '/') || paths[j].startsWith(paths[i] + '/')) throw new Error('Deployment directories must be disjoint');
  if (dev === '/root/production' || dev.startsWith('/root/production/')) throw new Error('Unsafe development directory');
  const builder = identity('BYTELIGHT_BUILD');
  const coder = identity('BYTELIGHT_CODEX');
  if (coder.gid === builder.gid || coder.uid === builder.uid || lstatSync(dev).uid !== coder.uid) throw new Error('Separate builder and Codex identities required');
  for (const p of [staging, backup, state, prod]) { trustedDirectory(p); const st = lstatSync(p); if (st.uid !== 0 || (st.mode & 0o022)) throw new Error('Privileged directory is writable by another identity'); }
  const app = process.env.BYTELIGHT_CODE_PM2_APP;
  const health = process.env.BYTELIGHT_CODE_HEALTH_URL;
  if (!app || !/^[a-zA-Z0-9_-]+$/.test(app) || !health || !/^http:\/\/127\.0\.0\.1:\d+\/api\/health$/.test(health)) throw new Error('Fixed PM2 app and loopback health URL required');
  const sqlite = process.env.BYTELIGHT_CODE_SQLITE_PATH;
  if (!sqlite || !sqlite.startsWith(prod + '/') || resolve(sqlite) !== sqlite) throw new Error('Fixed SQLite path required');
  return { dev, prod, staging, backup, state, builder, app, health, sqlite };
}
export const protectedCompiledPaths = [
  'services/builder-deployment.js', 'services/builder-release-bundle.js', 'services/builder-release-dependencies.js',
  'services/builder-release-ci.js',
  'services/code-deployment.js', 'services/code-deployment-worker.js', 'services/code-patch.js',
  'services/code-authorization.js', 'services/code-checkpoint.js', 'services/code-delegation.js',
  'services/chat-tool-belt.js', 'services/agent.js', 'services/agent/turn-input.js',
  'services/turn-origin.js', 'services/turn-audience.js', 'services/mcp-bridge.js', 'services/mcp-belt-auth.js',
  'services/telegram/config.js', 'services/telegram/debouncer.js', 'services/discord/config.js', 'services/discord/debouncer.js', 'middleware/auth.js', 'routes/api.js', 'config.js',
  'services/ws.js', 'services/discord/index.js', 'services/telegram/index.js',
  'services/living-room-relay.js', 'services/room-turns.js', 'services/commands.js',
  'routes/messages.js', 'routes/cards.js', 'routes/battleship.js',
  'services/story-shelf.js', 'services/library-book-club-turns.js', 'routes/rooms-routes.js',
  'routes/mcp-belt.js', 'services/runtimes/codex-daemon.js', 'services/runtimes/types.js',
].map(path => `packages/backend/dist/${path}`);

export const privilegedManifest = protectedCompiledPaths.map(compiled => ({ compiled, source: compiled.replace('/dist/', '/src/').replace(/\.js$/, '.ts') }));
export function validateFiles(files: string[]) {
  if (!files.length) throw new Error('Empty patch');
  for (const p of files) if (privilegedManifest.some(entry => p === entry.source || p === entry.source.replace(/\.ts$/, '.test.ts') || p === entry.compiled) || p.startsWith('/') || p.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.bl-') || part === '.build-home') || /(?:^|\/)(?:chat-tool-belt|mcp-bridge|mcp-belt-auth|turn-audience|agent|agent\/turn-input|routes\/mcp-belt|runtimes\/codex-daemon|runtimes\/types)(?:\.test)?\.(?:ts|js)$/.test(p) || /(^|\/)dist(\/|$)/.test(p) || /^packages\/frontend\/build(?:\/|$)/.test(p) || /(^|\/)code-(?:deployment(?:-worker)?|patch|authorization|checkpoint|delegation)(?:\.test)?\.(?:ts|js)$/.test(p) || /(^|\/)(?:package[^/]*\.json|npm-shrinkwrap\.json|[^/]*lock[^/]*|[^/]*\.(?:sh|bash|zsh|ksh|fish|ps1|bat|cmd)|scripts|\.github|\.npmrc|\.yarnrc[^/]*|pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json|bunfig\.toml|binding\.gyp|[^/]*config\.[^/]+|Makefile|Dockerfile)(\/|$)/i.test(p)) throw new Error(`Manual maintenance required: ${p}`);
}
const artifacts = ['packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
/** Anchor every traversal to an open directory fd; a builder cannot swap an ancestor for a symlink. */
function safeArtifactCopy(source: string, target: string): void {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      for (const name of readdirSync(`/proc/self/fd/${fd}`)) safeArtifactCopy(`/proc/self/fd/${fd}/${name}`, join(target, name));
    } else if (st.isFile() && st.nlink === 1) {
      writeFileSync(target, readFileSync(fd), { mode: 0o644, flag: 'wx' });
    } else throw new Error('Unsafe staged artifact');
  } finally { closeSync(fd); }
}
function sealArtifact(stage: string, path: string, target: string): void {
  const fds: number[] = [];
  try {
    let anchor = stage;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const fd = openSync(anchor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      fds.push(fd); anchor = `/proc/self/fd/${fd}/${part}`;
    }
    const fd = openSync(anchor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    fds.push(fd);
    safeArtifactCopy(`/proc/self/fd/${fd}/${parts.at(-1)}`, target);
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
function trustedFileBytes(path: string): Buffer {
  trustedDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || st.nlink !== 1) throw new Error('Trusted root-owned production file required');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export interface DeploymentBoundary { readTrustedFile?(path: string): Buffer; finalize?: typeof finalizeCheckpoint; configuration?(): ReturnType<typeof configuration>; chown?(path: string, uid: number, gid: number): void; snapshot?(cwd: string, mode?: { production: true; expectedFiles: string[] }): ReturnType<typeof pendingPatch>; git?(cwd: string, args: string[]): Buffer; promote?(source: string, target: string): void; run(file: string, args: string[], cwd: string, options?: { uid: number; gid: number; env: NodeJS.ProcessEnv }): string | Buffer | void; health(url: string): Promise<void>; }
const boundary: DeploymentBoundary = {
  run(file, args, cwd, options) { const cmd = execution(file, args, options); return execFileSync(cmd.file, cmd.args, { cwd, env: options?.env || safeEnv('/root'), timeout: 20 * 60_000, stdio: 'pipe' }); },
  async health(url) { const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!r.ok) throw new Error('Health check failed'); },
};
export async function runDeployment(key: string, io: DeploymentBoundary = boundary) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid worker key');
  const cfg = (io.configuration || configuration)(), dir = cfg.state;
  const snapshot = io.snapshot || pendingPatch;
  const git = io.git || gitBytes;
  const req = JSON.parse(readFileSync(join(dir, `${key}.request`), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'deploy.lock'), 'utf8'));
  if (lock.key !== key) throw new Error('Worker lock mismatch');
  atomic(join(dir, 'deploy.lock'), { pid: process.pid, key, state: 'running' });
  const result: Record<string, unknown> = { ...req, status: 'failed', lifecycle: 'Validating', validation: false, build: false, restart: false, health: false, rollback: null };
  const stage = join(cfg.staging, key), backup = join(cfg.backup, `${Date.now()}-${key}`);
  let touched = false;
  const prior: { path: string; existed: boolean }[] = [];
  const run = (f: string, a: string[], cwd = cfg.prod) => io.run(f, a, cwd);
  const stableHealth = () => stableDeploymentHealth(cfg, io);

  atomic(join(dir, `${digest(req.branch)}.failed`), { key, reason: 'validation incomplete' });
  atomic(join(dir, `${key}.json`), { ...result, status: 'pending' });
  try {
    const snap = snapshot(cfg.dev);
    if ((req.tree && snap.tree !== req.tree) || JSON.stringify(snap.files) !== JSON.stringify(req.files) || snap.diff_sha256 !== key || git(cfg.dev, ['branch', '--show-current']).toString().trim() !== req.branch || git(cfg.dev, ['rev-parse', 'HEAD']).toString().trim() !== req.head) throw new Error('Development snapshot changed');
    validateFiles(snap.files);
    if (!snap.patch.equals(readFileSync(join(dir, `${key}.patch`)))) throw new Error('Request patch mismatch');
    mkdirSync(stage, { mode: 0o700 });
    // Archive trusts committed public HEAD content; pending private paths are rejected.
    const archive = git(cfg.dev, ['archive', req.head]);
    // Only fixed data files are written while root owns the new, inaccessible directory.
    const tar = join(stage, '.bl-source.tar'), patch = join(stage, '.bl-source.patch');
    writeFileSync(tar, archive, { mode: 0o644, flag: 'wx' });
    writeFileSync(patch, snap.patch, { mode: 0o644, flag: 'wx' });
    // Upstream intentionally ignores package-lock.json. Pending manifest/lockfile edits
    // are forbidden, so reuse production's root-owned lock for a deterministic npm ci.
    const productionLock = join(cfg.prod, 'package-lock.json');
    writeFileSync(join(stage, 'package-lock.json'), (io.readTrustedFile || trustedFileBytes)(productionLock), { mode: 0o644, flag: 'wx' });
    const home = join(stage, '.build-home'); mkdirSync(home);
    (io.chown || chownSync)(home, cfg.builder.uid, cfg.builder.gid);
    (io.chown || chownSync)(stage, cfg.builder.uid, cfg.builder.gid);
    const options = { ...cfg.builder, env: { ...safeEnv(home), npm_config_cache: join(home, '.npm') } };
    io.run('/usr/bin/tar', ['-xf', tar, '-C', stage], stage, options);
    io.run('/usr/bin/git', ['apply', '--binary', patch], stage, options);
    io.run('/usr/bin/npm', ['ci', '--ignore-scripts'], stage, options);
    io.run('/usr/bin/npm', ['rebuild', 'better-sqlite3', 'esbuild', '--ignore-scripts=false'], stage, options);
    for (const test of ['code-deployment', 'code-authorization', 'code-checkpoint']) io.run('/usr/bin/node', ['--import', 'tsx', `packages/backend/src/services/${test}.test.ts`], stage, options);
    for (const test of ['packages/frontend/src/lib/utils/model-catalog.test.ts', 'packages/phone/src/lib/model-catalog.test.ts']) io.run('/usr/bin/node', ['--import', 'tsx', test], stage, options);
    io.run('/usr/bin/npm', ['run', 'build'], stage, options);
    // Seal artifacts into root-only storage before promotion. No child remains able to alter the sealed copy.
    const sealed = join(dir, `${key}.artifacts`);
    mkdirSync(sealed, { mode: 0o700 });
    for (const path of artifacts) sealArtifact(stage, path, join(sealed, path));
    result.build = true; result.lifecycle = 'Deploying';
    atomic(join(dir, `${key}.json`), { ...result, status: 'pending', phase: 'built' });
    if (snapshot(cfg.dev).diff_sha256 !== key) throw new Error('Development diff changed during build');
    await stableHealth();
    if (git(cfg.prod, ['rev-parse', 'HEAD']).toString().trim() !== req.head || snapshot(cfg.prod, { production: true, expectedFiles: [] }).files.length) throw new Error('Production baseline mismatch or tracked changes');
    run('/usr/bin/git', ['apply', '--check', '--binary', join(dir, `${key}.patch`)]);
    // Build/test code is untrusted even when source manifests are unchanged. Never
    // replace the root coordinator's executable modules with builder-produced bytes.
    for (const relative of protectedCompiledPaths) {
      const source = join(cfg.prod, relative);
      const trustedBytes = (io.readTrustedFile || trustedFileBytes)(source);
      const target = join(sealed, relative);
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { force: true });
      writeFileSync(target, trustedBytes, { mode: 0o644, flag: 'wx' });
    }
    result.validation = true;
    mkdirSync(backup, { mode: 0o700 }); result.backup = backup;
    for (const path of [...snap.files, ...artifacts]) {
      const target = join(cfg.prod, path);
      let cursor = cfg.prod;
      for (const part of path.split('/')) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Production symlink forbidden'); }
      const existed = existsSync(target);
      if (existed && !artifacts.includes(path)) { const st = lstatSync(target); if (!st.isFile() || st.nlink !== 1) throw new Error('Unsafe production source file'); }
      prior.push({ path, existed });
      if (existed) { mkdirSync(dirname(join(backup, path)), { recursive: true }); if (artifacts.includes(path)) safeArtifactCopy(target, join(backup, path)); else cpSync(target, join(backup, path), { recursive: true }); }
    }
    atomic(join(backup, 'source-state.json'), { prior });
    // SQLite online backup through the fixed system utility, never through edited application code.
    run('/usr/bin/sqlite3', [cfg.sqlite, `.backup '${join(backup, 'database.sqlite').replace(/'/g, "''")}'`]);
    atomic(join(dir, `${key}.json`), { ...result, status: 'pending', phase: 'backup_complete' });
    touched = true;
    run('/usr/bin/pm2', ['stop', cfg.app]);
    run('/usr/bin/git', ['apply', '--binary', join(dir, `${key}.patch`)]);
    for (const path of artifacts) { rmSync(join(cfg.prod, path), { recursive: true, force: true }); if (io.promote) io.promote(join(dir, `${key}.artifacts`, path), join(cfg.prod, path)); else safeArtifactCopy(join(dir, `${key}.artifacts`, path), join(cfg.prod, path)); }
    run('/usr/bin/pm2', ['restart', cfg.app]); result.restart = true;
    await stableHealth(); result.health = true; result.lifecycle = 'Live';
    atomic(join(dir, `${key}.json`), { ...result, status: 'pending' });
    Object.assign(result, (io.finalize || finalizeCheckpoint)(cfg.dev, cfg.prod, req, readFileSync(join(dir, `${key}.patch`))));
    if (result.development_main_head !== result.checkpoint_id) throw new Error('Checkpoint development main verification missing');
    result.development_head = result.checkpoint_id; result.production_head = result.checkpoint_id;
    result.development_tree = result.tree; result.production_tree = result.tree;
    result.status = 'deployed'; result.lifecycle = 'Clean';
  } catch (e) {
    try { atomic(join(dir, `${digest(req.branch)}.failed`), { key, reason: 'validation or deployment failed' }); } catch (markerError) { result.marker_error = String(markerError); }
    result.error = String(e); result.lifecycle = 'Failed';
    if (String(e).includes('Recovery Required:')) {
      let stopped = false;
      try { run('/usr/bin/pm2', ['stop', cfg.app]); stopped = true; } catch {}
      result.status = 'recovery_required'; result.lifecycle = 'Recovery Required';
      result.rollback = { ok: false, stopped, error: 'Checkpoint restoration failed; manual recovery required' };
      result.recovery_material = { stage, sealed: join(dir, `${key}.artifacts`), backup, request: join(dir, `${key}.request`), repositories: [cfg.dev, cfg.prod].map(repo => {
        try { return { repo, refs: git(repo, ['show-ref', '--heads']).toString(), worktree: git(repo, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']).toString(), index: join(repo, '.git/index') }; }
        catch (error) { return { repo, diagnostic_error: String(error), index: join(repo, '.git/index') }; }
      }) };
    } else if (touched) {
      try {
        run('/usr/bin/pm2', ['stop', cfg.app]);
        for (const { path, existed } of prior) { rmSync(join(cfg.prod, path), { recursive: true, force: true }); if (existed) { if (artifacts.includes(path)) safeArtifactCopy(join(backup, path), join(cfg.prod, path)); else cpSync(join(backup, path), join(cfg.prod, path), { recursive: true }); } }
        run('/usr/bin/sqlite3', [cfg.sqlite, `.restore '${join(backup, 'database.sqlite').replace(/'/g, "''")}'`]);
        run('/usr/bin/pm2', ['restart', cfg.app]); await stableHealth();
        result.status = 'rolled_back'; result.lifecycle = 'Rolled Back'; result.rollback = { ok: true };
      } catch (rollbackError) {
        let stopped = false;
        try { run('/usr/bin/pm2', ['stop', cfg.app]); stopped = true; } catch {}
        result.status = 'recovery_required'; result.lifecycle = 'Recovery Required'; result.rollback = { ok: false, stopped, error: String(rollbackError) };
      }
    }
  } finally {
    if (String(result.error).includes('Recovery Required:')) { result.status = 'recovery_required'; result.lifecycle = 'Recovery Required'; }
    result.next = result.status === 'deployed' ? 'Deployment and synchronized local checkpoint complete; no push performed.' : 'Review persisted diagnostics before any further deployment.';
    atomic(join(dir, `${key}.json`), result);
    if (result.lifecycle === 'Clean') { try { rmSync(join(dir, `${digest(req.branch)}.failed`), { force: true }); } catch { /* Retaining the conservative branch marker is safe. */ } }
    if (result.status !== 'recovery_required') {
      rmSync(stage, { recursive: true, force: true });
      rmSync(join(dir, `${key}.artifacts`), { recursive: true, force: true });
      rmSync(join(dir, 'deploy.lock'), { force: true });
    }
  }
}

export async function stableDeploymentHealth(cfg: { app: string; health: string; prod?: string }, io: Pick<DeploymentBoundary, 'run' | 'health'>, pause = io === boundary) {
  const run = (file: string, args: string[]) => io.run(file, args, cfg.prod || '/');
  let consecutive = 0, error: unknown, previous = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const list = JSON.parse(String(run('/usr/bin/pm2', ['jlist']) || 'null'));
      const matches = Array.isArray(list) ? list.filter(p => p.name === cfg.app) : [];
      const app = matches[0], restarts = app?.pm2_env?.restart_time;
      if (matches.length !== 1 || app.pm2_env?.status !== 'online' || !Number.isSafeInteger(app.pid) || app.pid <= 0 || !Number.isSafeInteger(restarts) || restarts < 0) throw new Error('PM2 application must be uniquely online with valid PID/restart count');
      const current = `${app.pid}:${restarts}`;
      if (current !== previous) consecutive = 0;
      previous = current;
      await io.health(cfg.health);
      if (++consecutive === 3) return { pid: app.pid as number, restarts: restarts as number };
    } catch (e) { consecutive = 0; previous = ''; error = e; }
    if (pause) await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Consecutive PM2/health checks failed: ${String(error)}`);
}
