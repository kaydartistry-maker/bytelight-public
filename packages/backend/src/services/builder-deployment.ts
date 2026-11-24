/** Trusted-owner releases: durable operations and recovery, not per-patch approval. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chownSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { BeltContext } from './chat-tool-belt.js';
import { builderConfig, builderGit, builderOwner, assertBuilderBaseline, openBuilderStore, type BuilderConfig, type BuilderOwner } from './builder-jobs.js';
import type { BuilderJob, ReleaseRecord } from './db/builder-jobs.js';
import { appendEvent, assertJobId, canonicalRoot, matchesProcess, privateDirectory, processIdentity, redact, readEvents, type ProcessIdentity } from './builder-job-io.js';
import { configuration, stableDeploymentHealth, startDetachedWorker, workerReady, protectedCompiledPaths } from './code-deployment.js';
import { execution, gitBytes, safeEnv } from './code-patch.js';

import { DependencyCache, dependencyKey, removePublishedDependencies } from './builder-release-dependencies.js';
import { sealReleaseBundle, verifyReleaseBundle } from './builder-release-bundle.js';
import { assertCIProtectedBytes, assertNoCIFailure, ciConfiguration, ciSha, expectedCISource, freezeCIProof, importCIOutputs, loadAdmittedCI, notifyCIGateway, verifyFrozenCI, type CIConfig, type CIExpected, type CIGateway, type CIPin, type CIRuntime, type VerifiedCI } from './builder-release-ci.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifacts = ['node_modules', 'packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
const trustPath = /(?:^|\/)(?:code-(?:deployment(?:-worker)?|patch|authorization|checkpoint)|builder-(?:deployment(?:-worker)?|release-(?:bundle|dependencies|ci)|jobs|job-worker|job-process)|ecosystem[^/]*|[^/]*\.service|[^/]*\.socket)(?:\.|$)|(?:^|\/)(?:ecosystem[^/]*|pm2[^/]*|systemd)(?:\.|\/|$)|^(?:scripts\/.*(?:deploy|pm2|backup|restart)|\.github\/|packages\/backend\/src\/services\/db\/(?:init|builder-jobs)\.ts$)/i;
export function credentialPath(path: string): boolean {
  // Public configuration template shipped by this repository, never the runtime config.
  if (path === 'examples/bytelight.yaml') return false;
  return path.split('/').some(part => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.codex|\.npmrc|\.netrc|\.git-credentials|data|logs|memory-vault|vault|auth\.json|credentials(?:\.[^/]*)?|bytelight\.yaml)$/i.test(part) && !/\.(?:example|sample)$/.test(part)) || /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db)(?:$|[-.])/i.test(path);
}
function safePath(path: string): void {
  if (!path || path.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe repository path');
}
/** Forward-only expand contract. Existing tables/columns/data and constraints never change. */
export function additiveSql(sql: string): string[] {
  // Comments and strings are lexed before classifying, so quoted punctuation cannot add statements.
  const tokens = sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) || [];
  const statements: string[] = []; let current: string[] = [];
  for (const token of tokens.filter(t => !t.startsWith('--') && !t.startsWith('/*'))) {
    if (token === ';') { if (current.length) statements.push(current.join(' ')); current = []; } else current.push(token);
  }
  if (current.length) statements.push(current.join(' '));
  if (!statements.length) throw new Error('Empty additive migration');
  for (const statement of statements) {
    const bare = statement.replace(/'(?:''|[^'])*'/g, "''").toUpperCase();
    const create = /^CREATE TABLE IF NOT EXISTS [A-Z_][A-Z_0-9]* \(/.test(bare);
    const index = /^CREATE INDEX IF NOT EXISTS [A-Z_][A-Z_0-9]* ON [A-Z_][A-Z_0-9]* \( [A-Z_][A-Z_0-9]*(?: , [A-Z_][A-Z_0-9]*)* \)$/.test(bare);
    const column = /^ALTER TABLE [A-Z_][A-Z_0-9]* ADD (?:COLUMN )?[A-Z_][A-Z_0-9]* (?:TEXT|INTEGER|REAL|BLOB)(?: DEFAULT (?:NULL|-? \d+(?: \. \d+)?|\d+(?:\.\d+)?|''))?$/.test(bare);
    if ((!create && !index && !column) || /\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT|REPLACE|ATTACH|DETACH|PRAGMA|TRIGGER|REFERENCES|CHECK|GENERATED|SELECT)\b/.test(bare)) throw new Error('Exceptional migration: only backward-compatible additive SQL is autonomous');
    // New tables may have their own primary/unique constraints. Existing tables get nullable columns only.
    if (create && (!bare.endsWith(')') || /\bAS\b/.test(bare))) throw new Error('Unsupported CREATE TABLE migration');
  }
  return statements;
}
export interface ReleasePlan { commit: string; base: string; tree: string; paths: string[]; changed: string[]; migrations: { path: string; sql: string; digest: string }[]; native: string[]; lock: string; }
export interface ReleaseConfig { builder: BuilderConfig; prod: string; state: string; staging: string; backup: string; app: string; health: string; sqlite: string; build: { uid: number; gid: number }; ci?: CIConfig; }
/** Core recovery configuration never depends on the current CI service/inbox. */
export function releaseConfig(preparation = false): ReleaseConfig {
  if (process.env.BYTELIGHT_BUILDER_DEPLOY_ENABLED !== 'true') throw new Error('Builder deployment is disabled');
  if (process.getuid?.() !== 0) throw new Error('Existing root deployment coordinator required');
  const builder = builderConfig(), old = configuration(builder.source);
  const roots = [builder.root, builder.workRoot, builder.source, builder.home, old.prod, old.state, old.staging, old.backup];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (roots[i] === roots[j] || roots[i].startsWith(roots[j] + '/') || roots[j].startsWith(roots[i] + '/')) throw new Error('Builder/deployment storage must be disjoint');
  return { builder, prod: old.prod, state: old.state, staging: old.staging, backup: old.backup, app: old.app, health: old.health, sqlite: old.sqlite, build: old.builder, ...(preparation?{ci:ciConfiguration(builder.root)}:{}) };
}
export interface ReleaseIO {
  git(cwd: string, args: string[]): Buffer;
  inspect(pid: number): ProcessIdentity | null;
  run(file: string, args: string[], cwd: string): string | Buffer | void;
  build(file: string, args: string[], cwd: string, config: ReleaseConfig): string | Buffer | void;
  health(url: string): Promise<void>;
  pauseHealth?: boolean;
  chown?(path: string, uid: number, gid: number): void;
  promote?(source: string, target: string): void;
  persist?(record: ReleaseRecord): void; // Fixture fault injection before durable metadata writes.
  notifyCI?(gateway:CIGateway,event:{jobId:string;releaseId:string}):Promise<void>;
  ciPause?(ms:number):Promise<void>;
  ciNow?():number;
}
/** Mask private parents before binding the writable stage back into the sandbox. */
export function releasePrivateMasks(config: ReleaseConfig): string[] {
  const paths = [config.prod, config.state, config.backup, config.builder.root,
    config.builder.workRoot, config.builder.source, config.builder.home];
  const checked = paths.map(path => {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f\\]/.test(path)) throw new Error('Unsafe release sandbox mask');
    const normalized = resolve(path);
    if (normalized === '/' || dirname(normalized) === '/') throw new Error('Unsafe release sandbox mask');
    return normalized;
  });
  checked[3] = dirname(checked[3]);
  for (const path of checked) if (path === '/' || dirname(path) === '/') throw new Error('Unsafe release sandbox mask');
  return [...new Set(['/root', ...checked])].sort().filter((path, _, all) => !all.some(parent => parent !== path && path.startsWith(parent + '/')));
}
export function releaseSandboxArgs(file: string, args: string[], cwd: string, config: ReleaseConfig): string[] {
  return ['--unshare-pid', '--die-with-parent', '--ro-bind', '/', '/',
    '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run',
    '--ro-bind', '/etc/resolv.conf', realpathSync('/etc/resolv.conf'),
    ...releasePrivateMasks(config).flatMap(path => ['--tmpfs', path]),
    '--bind', cwd, cwd, '--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--', file, ...args];
}
export const releaseIO: ReleaseIO = {
  git: gitBytes, inspect: processIdentity,
  run(file, args, cwd) { return execFileSync(file, args, { cwd, env: { ...safeEnv('/root'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); },
  build(file, args, cwd, config) {
    const command = execution('/usr/bin/bwrap', releaseSandboxArgs(file, args, cwd, config), config.build);
    try { return execFileSync(command.file, command.args, { cwd, env: { ...safeEnv(join(cwd, '.build-home')), npm_config_cache: join(cwd, '.build-home/.npm') }, timeout: 20 * 60_000, maxBuffer: 1024 * 1024 }); }
    catch (error) { throw new Error(`Build command failed: ${file} ${args.join(' ')}: ${redact(String(error)).slice(0, 4000)}`); }
  },
  async health(url) { const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!response.ok) throw new Error('Health check failed'); },
  pauseHealth: true,
};
function git(io: ReleaseIO, cwd: string, args: string[]): string { return io.git(cwd, ['-c', 'core.hooksPath=/dev/null', ...args]).toString().trim(); }
function dead(job: BuilderJob, io: ReleaseIO): void {
  // Refuse even a reused live PID. No signalling or guessing about a still-live writer.
  for (const pid of [job.workerPid, job.childPid]) if (pid && io.inspect(pid)) throw new Error('Builder worker/process is still live; wait for quiescence');
}
export function eligible(job: BuilderJob, cfg: ReleaseConfig, io = releaseIO): ReleasePlan {
  assertBuilderBaseline(cfg.builder, job.baseCommit, (cwd, args) => git(io, cwd, args));
  if (cfg.builder.base === 'deployed' && realpathSync(resolve(job.workspace, git(io, job.workspace, ['rev-parse', '--git-common-dir']))) !== realpathSync(cfg.builder.source)) throw new Error('Builder workspace is not in the dedicated source repository');
  if (job.status !== 'succeeded') throw new Error('Only a successful builder job can be released');
  assertJobId(job.id); dead(job, io);
  if (job.workspace !== join(cfg.builder.workRoot, job.id) || realpathSync(job.workspace) !== job.workspace) throw new Error('Retained builder workspace mismatch');
  const text = (args: string[]) => git(io, job.workspace, args);
  if (text(['rev-parse', '--show-toplevel']) !== job.workspace || text(['branch', '--show-current']) !== job.branch || text(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Builder branch/worktree must be exact and clean');
  const commit = text(['rev-parse', '--verify', 'HEAD^{commit}']), tree = text(['rev-parse', 'HEAD^{tree}']);
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(job.baseCommit) || commit === job.baseCommit) throw new Error('A new clean commit is required');
  text(['merge-base', '--is-ancestor', job.baseCommit, commit]);
  if (git(io, cfg.prod, ['rev-parse', 'HEAD']) !== job.baseCommit || git(io, cfg.prod, ['diff', '--name-only', 'HEAD'])) throw new Error('Production baseline differs; rebuild from the current release');
  const entries = io.git(job.workspace, ['ls-tree', '-rz', '--full-tree', commit]).toString().split('\0').filter(Boolean);
  const paths = entries.map(entry => {
    if (!/^(100644|100755) blob [a-f0-9]+\t/.test(entry)) throw new Error('Submodules/symlinks/special source files are not releasable');
    const path = entry.slice(entry.indexOf('\t') + 1); safePath(path); if (credentialPath(path)) throw new Error(`Credential/private runtime path is not releasable: ${path}`); return path;
  });
  const changed = io.git(job.workspace, ['diff', '--name-only', '-z', '--no-renames', job.baseCommit, commit]).toString().split('\0').filter(Boolean);
  for (const a of changed) if (changed.some(b => b !== a && b.startsWith(a + '/'))) throw new Error('File/directory shape changes require a separate release');
  const migrations: ReleasePlan['migrations'] = [];
  for (const path of changed) {
    safePath(path);
    if (credentialPath(path) || /(?:^|\/)\.gitattributes$/.test(path) || trustPath.test(path) || /^packages\/backend\/migrations\/builder_/.test(path) || /(?:^|\/)(?:\.npmrc|\.yarnrc[^/]*|[^/]*\.sh|Dockerfile|Makefile)$/.test(path)) throw new Error(`Exceptional deployment/root/private change requires separate maintenance: ${path}`);
    // CI imports preserve all installed protected executable bytes, not merely
    // the smaller legacy builder trustPath subset. Reject their source edits
    // at admission rather than waiting for an expensive CI build to fail import.
    if(cfg.ci?.mode==='verified-ci'&&protectedCompiledPaths.some(compiled=>path===compiled||path===compiled.replace('/dist/','/src/').replace(/\.js$/,'.ts')))throw Error(`Verified CI protected source change requires explicit root maintenance: ${path}`);
    if (/\.sql$/i.test(path)) {
      if (!/^packages\/backend\/migrations\/\d+_[\w-]+\.sql$/.test(path)) throw new Error('SQL changes need an additive migration file');
      let existed = false; try { io.git(job.workspace, ['cat-file', '-e', `${job.baseCommit}:${path}`]); existed = true; } catch { /* newly added migration */ }
      if (existed || !paths.includes(path)) throw new Error('Existing migrations cannot be modified or removed');
      const sql = io.git(job.workspace, ['show', `${commit}:${path}`]).toString(); additiveSql(sql); migrations.push({ path, sql, digest: hash(sql) });
    }
  }
  const manifestsChanged = changed.some(p => /(?:^|\/)package(?:-lock)?\.json$/.test(p));
  let lock: string;
  if (paths.includes('package-lock.json')) lock = io.git(job.workspace, ['show', `${commit}:package-lock.json`]).toString();
  else {
    if (manifestsChanged) throw new Error('Dependency changes require a committed package-lock.json (git add -f if ignored)');
    lock = readFileSync(join(cfg.prod, 'package-lock.json'), 'utf8');
  }
  const locked = JSON.parse(lock); if (!locked.packages || locked.lockfileVersion < 2) throw new Error('A modern complete npm lock is required');
  const baseline = JSON.parse(io.git(job.workspace, ['show', `${job.baseCommit}:package.json`]).toString());
  const native: string[] = [];
  for (const [spec, allowed] of Object.entries(baseline.allowScripts || {})) {
    if (!allowed) continue;
    const at = spec.lastIndexOf('@'), name = spec.slice(0, at), version = spec.slice(at + 1);
    const record = locked.packages[`node_modules/${name}`];
    if (record && record.version === version) native.push(`${name}@${version}`);
    else if (record?.hasInstallScript) throw new Error(`Native toolchain version needs exceptional review: ${name}`);
  }
  if (text(['rev-parse', 'HEAD']) !== commit || text(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Builder commit/ref changed during admission');
  return { commit, base: job.baseCommit, tree, paths, changed, migrations, native, lock };
}
function atomic(path: string, value: unknown): void {
  const fd = openSync(`${path}.tmp`, 'w', 0o600); try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.tmp`, path); const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function releaseDir(cfg: ReleaseConfig, id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid release id'); return join(cfg.builder.root, 'deployments', id); }
function lock(cfg: ReleaseConfig, record: ReleaseRecord): void { writeFileSync(join(cfg.state, 'deploy.lock'), JSON.stringify({ key: record.id, state: 'starting', pid: process.pid, kind: 'builder' }), { flag: 'wx', mode: 0o600 }); }
function unlock(cfg: ReleaseConfig, id: string): void { const path = join(cfg.state, 'deploy.lock'); if (JSON.parse(readFileSync(path, 'utf8')).key !== id) throw new Error('Deployment lock identity changed'); rmSync(path); }
function assertLock(cfg: ReleaseConfig, id: string): void { if (JSON.parse(readFileSync(join(cfg.state, 'deploy.lock'), 'utf8')).key !== id) throw new Error('Deployment lock mismatch'); }
export function publicRelease(record: ReleaseRecord): object { const { worker: _worker, ...result } = record; return result; }
interface Request { config: ReleaseConfig; plan: ReleasePlan; job: BuilderJob; operation: 'prepare' | 'deploy' | 'rollback'; bundleSha256?: string; ciImport?: CIPin; }
function readRequest(root: string, id: string): Request {
  privateDirectory(root); const dir = join(root, 'deployments', id); privateDirectory(dir);
  const path = join(dir, 'request.json'), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 8 * 1024 * 1024) throw new Error('Unsafe release request');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function pinnedBundle(cfg: ReleaseConfig, record: ReleaseRecord, request: Request): string {
  const dir=releaseDir(cfg,record.id), manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  if(!record.bundleSha256 || record.bundleSha256!==request.bundleSha256 || record.bundleSha256!==manifest.bundleSha256) throw new Error('Missing/mismatched sealed source bundle evidence; reprepare this release');
  const digest=verifyReleaseBundle(dir,request.plan,record.bundleSha256);
  if(request.config.ci?.mode==='verified-ci'||request.ciImport||record.ciImport||manifest.ciImport){
    if(!request.ciImport||JSON.stringify(request.ciImport)!==JSON.stringify(record.ciImport)||JSON.stringify(request.ciImport)!==JSON.stringify(manifest.ciImport))throw Error('Missing/mismatched CI proof pins; reprepare this release');
    verifyFrozenCI(dir,request.ciImport,digest);
  }
  return digest;
}
function runtimePaths(root: string): string[] {
  const found: string[] = [];
  function walk(path: string) { for (const name of readdirSync(path)) { const full = join(path, name); if (name === 'node_modules') found.push(relative(root, full)); else if (lstatSync(full).isDirectory() && !name.startsWith('.')) walk(full); } }
  walk(join(root, 'packages')); return [...artifacts, ...found].filter((p, i, all) => all.indexOf(p) === i && !all.some(q => q !== p && p.startsWith(q + '/')));
}
/** Complete dependency trees retain internal npm workspace/bin symlinks only. */
export function copyReleaseTree(source: string, target: string, root = source, purpose?: 'dependency-cache-publication'): void {
  // Existing parents must never redirect an exclusive file copy through a symlink.
  let parent = resolve(dirname(target));
  const missingParents: string[] = [];
  while (true) {
    try { const st = lstatSync(parent); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe release copy destination'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missingParents.push(parent); }
    if (dirname(parent) === parent) break; parent = dirname(parent);
  }
  // Create only missing ancestors with safe modes; never chmod caller directories.
  for (const path of missingParents.reverse()) mkdirSync(path, { mode: 0o755 });
  function copy(source: string, target: string): void {
    const st = lstatSync(source);
    if (st.isSymbolicLink()) {
      const link = readlinkSync(source), resolved = resolve(dirname(source), link);
      if (isAbsolute(link) || (!resolved.startsWith(root + '/') && resolved !== root)) throw new Error('Release symlink escapes its tree');
      symlinkSync(link, target); return;
    }
    if (st.isDirectory()) { mkdirSync(target, { mode: 0o755 }); for (const name of readdirSync(source)) copy(join(source, name), join(target, name)); }
    else if (st.isFile() && (st.nlink === 1 || purpose === 'dependency-cache-publication')) {
      copyFileSync(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      // Root copyFile can preserve the build owner's uid/gid. The exclusive
      // destination is a new regular inode, never a symlink target.
      chownSync(target, process.getuid!(), process.getgid!());
      chmodSync(target, st.mode & 0o111 ? 0o755 : 0o644);
    }
    else {
      // Encode control characters and omit absolute source/target paths and link targets.
      const path = relative(resolve(root), resolve(source));
      const safePath = path === '..' || path.startsWith('../') || isAbsolute(path) ? '[outside tree]' : path || '.';
      const type = st.isFile() ? 'regular' : st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isBlockDevice() ? 'block' : st.isCharacterDevice() ? 'character' : 'unknown';
      throw new Error(`Special file in release: path=${JSON.stringify(safePath)} type=${type} nlink=${st.nlink}`);
    }
  }
  copy(source, target);
}
export function identityDigest(root: string, paths: string[]): string {
  const digest = createHash('sha256');
  const field = (value: string | Buffer) => { digest.update(String(Buffer.byteLength(value)) + ':'); digest.update(value); };
  field('release-identity-v2');
  function visit(path: string) {
    field(relative(root, path));
    let st;
    try { st = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; field('absent'); return; }
    field(String(st.mode & 0o777));
    if (st.isSymbolicLink()) { field('link'); field(readlinkSync(path)); }
    else if (st.isDirectory()) { field('directory'); for (const name of readdirSync(path).sort()) visit(join(path, name)); field('end'); }
    else if (st.isFile()) { field('file'); field(readFileSync(path)); }
    else throw new Error('Unsafe runtime identity');
  }
  for (const path of [...paths].sort()) visit(join(root, path)); return digest.digest('hex');
}

function noSymlinkAncestor(root: string, path: string): void { safePath(path); let cursor = root; for (const part of path.split('/')) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Production path has symlink ancestor'); } }
function replace(source: string, target: string, io: ReleaseIO, root: string): void {
  const temp = `${target}.builder-next`; if (existsSync(temp)) throw new Error('Retained partial promotion needs inspection');
  try { if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); if (io.promote) io.promote(source, temp); else copyReleaseTree(source, temp, root); } } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  rmSync(target, { recursive: true, force: true }); if (existsSync(temp)) renameSync(temp, target);
}
/** Delete only an exact direct child of a canonical, real directory. Missing targets are harmless. */
function cleanupDirectory(parent: string, name: string, pattern: RegExp, remove = true): void {
  if (!pattern.test(name) || dirname(join(parent, name)) !== parent || realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('Unsafe artifact cleanup parent/name');
  const target = join(parent, name);
  let stat;
  try { stat = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && remove) return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(target) !== target) throw new Error('Unsafe artifact cleanup target');
  if (remove) rmSync(target, { recursive: true });
}
export async function runBuilderRelease(root: string, id: string, io = releaseIO): Promise<void> {
  const request = readRequest(root, id), { config: cfg, plan, job, operation } = request;
  if (cfg.builder.root !== root) throw new Error('Release root mismatch');
  const store = openBuilderStore(root), dir = releaseDir(cfg, id), stage = join(cfg.staging, `builder-${id}`), sealed = join(dir, 'release'), previous = join(cfg.backup, `builder-${id}`);
  let record = store.release(id)!; if (!record || record.jobId !== job.id) throw new Error('Release/job association mismatch');
  const worker = io.inspect(process.pid); record = { ...record, worker: worker || undefined };
  let safeToUnlock = false;
  const phaseTimes: Record<string, number> = {}; let phase = 'worker-start', tick = performance.now(); const operationStart = tick;
  const measure = () => { const now = performance.now(); phaseTimes[phase] = (phaseTimes[phase] || 0) + now - tick; tick = now; };
  const update = (patch: Partial<ReleaseRecord>) => { measure(); if (patch.phase) phase = patch.phase; patch.metrics = { ...record.metrics, [operation]: { ...phaseTimes, _elapsed: performance.now() - operationStart } }; record = { ...record, ...patch, updated: new Date().toISOString() }; io.persist?.(record); store.saveRelease(record); atomic(join(cfg.state, `${id}.json`), publicRelease(record)); safeToUnlock = ['prepared', 'deployed', 'rolled_back', 'failed'].includes(record.status); };
  const recoveryUpdate = (patch: Partial<ReleaseRecord>) => { try { update(patch); } catch { safeToUnlock = false; } };
  const log = (message: string) => appendEvent(join(dir, 'events.jsonl'), 'deployment', message);
  const terminalLog = (message: string) => { try { log(message); } catch { /* Terminal metadata is authoritative; logging cannot reverse a completed effect. */ } };
  const currentPath = join(cfg.state, 'builder-current.json');
  const restoreMarker = (restore: { current?: unknown }) => { if (restore.current) atomic(currentPath, restore.current); else rmSync(currentPath, { force: true }); };
  const run = (file: string, args: string[]) => io.run(file, args, cfg.prod);
  const health = () => stableDeploymentHealth(cfg, { run: io.run.bind(io), health: io.health.bind(io) }, !!io.pauseHealth);
  const sourceRef = () => git(io, cfg.builder.source, ['rev-parse', '--verify', 'refs/heads/deployed^{commit}']);
  const moveSource = (from: string, to: string) => { if (cfg.builder.base === 'deployed') git(io, cfg.builder.source, ['update-ref', 'refs/heads/deployed', to, from]); };
  const restoreSource = () => { if (cfg.builder.base !== 'deployed') return; const current = sourceRef(); if (current === plan.commit) moveSource(plan.commit, plan.base); else if (current !== plan.base) throw new Error('Builder source ref drift during rollback; manual inspection required'); };
  const stableBaseline = () => { assertBuilderBaseline(cfg.builder, plan.base, (cwd, args) => git(io, cwd, args)); dead(job, io); if (git(io, cfg.prod, ['rev-parse', 'HEAD']) !== plan.base || git(io, cfg.prod, ['diff', '--name-only', 'HEAD'])) throw new Error('Production baseline drift'); };
  let touched = false, started = false, stopped = false;
  let affected: string[] = [], prior: { path: string; existed: boolean }[] = [];
  try {
    assertLock(cfg, id); atomic(join(cfg.state, 'deploy.lock'), { key: id, pid: process.pid, worker, kind: 'builder', state: 'running' });
    if (operation === 'prepare') {
      update({ status: 'preparing', phase: 'validating' });
      const fresh = eligible(store.get(job.id)!, cfg, io);
      if (hash(JSON.stringify(fresh)) !== hash(JSON.stringify(plan))) throw new Error('Pinned builder source/lock changed');
      const bundleSha256 = sealReleaseBundle(dir, job.workspace, job.branch, plan, cfg.builder);
      dead(store.get(job.id)!, io);
      request.bundleSha256 = bundleSha256; atomic(join(dir, 'request.json'), request);
      update({ bundleSha256 }); log(`Sealed source bundle SHA256 ${bundleSha256}`);
      mkdirSync(stage, { mode: 0o755 });
      writeFileSync(join(stage, '.source.tar'), io.git(job.workspace, ['archive', plan.commit]), { mode: 0o644, flag: 'wx' });
      (io.chown || chownSync)(stage, cfg.build.uid, cfg.build.gid);
      io.build('/usr/bin/tar', ['-xf', '.source.tar', '--no-same-owner', '--no-same-permissions'], stage, cfg);
      writeFileSync(join(stage, 'package-lock.json'), plan.lock, { mode: 0o644 });
      mkdirSync(join(stage, '.build-home'), { mode: 0o700 }); (io.chown || chownSync)(join(stage, '.build-home'), cfg.build.uid, cfg.build.gid);
      log('Installing dependencies with lifecycle scripts disabled.'); update({ phase: 'dependencies' });
      // Key exact admitted bytes, never the coder's install. All manifests and non-src
      // policy/tooling inputs participate; only ordinary source/docs edits can reuse.
      const nodeRuntime=String(io.build('/usr/bin/env', ['node', '-p', `JSON.stringify({ versions:process.versions, platform:process.platform, arch:process.arch, libc:process.report.getReport().header.glibcVersionRuntime || null, binary:require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.execPath)).digest('hex') })`], stage, cfg));
      const npmVersion=String(io.build('/usr/bin/npm',['--version'],stage,cfg)).trim();
      const inputs: [string, string][] = [['package-lock.json', plan.lock],
        ['npm-node-runtime', nodeRuntime],
        ['trusted-policy', readFileSync(fileURLToPath(import.meta.url), 'utf8')],
        ['trusted-cache', readFileSync(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './builder-release-dependencies.ts' : './builder-release-dependencies.js', import.meta.url)), 'utf8')],
        ['npm', npmVersion],
        ['npm-install-policy', String(io.build('/usr/bin/npm', ['config', 'get', 'omit', 'include', 'install-strategy', 'install-links', 'legacy-peer-deps', 'strict-peer-deps', 'bin-links', 'ignore-scripts', 'node-options', 'cpu', 'os', 'libc'], stage, cfg))],
        ['trusted-environment', readFileSync(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './code-patch.ts' : './code-patch.js', import.meta.url)), 'utf8')]];
      const nativeNames = plan.native.map(spec => spec.slice(0, spec.lastIndexOf('@')));
      const workspaceNative = plan.paths.filter(p => /(?:^|\/)package\.json$/.test(p)).some(p => nativeNames.includes(JSON.parse(io.git(job.workspace, ['show', `${plan.commit}:${p}`]).toString()).name));
      const localDependencies = workspaceNative || Object.values(JSON.parse(plan.lock).packages as Record<string, { resolved?: string; link?: boolean }>).some(p => p.resolved !== undefined && !/^(?:https?:|git(?:\+[^:]+)?:)/.test(p.resolved) && !p.link);
      for (const path of plan.paths) if (localDependencies || /(?:^|\/)package(?:-lock)?\.json$/.test(path) || !/^packages\/[^/]+\/src\//.test(path) && !/\.md$/.test(path)) inputs.push([path, io.git(job.workspace, ['show', `${plan.commit}:${path}`]).toString('base64')]);
      const key = dependencyKey(inputs, plan.native);
      const mode=cfg.ci===undefined?'local':cfg.ci.mode;if(mode!=='local'&&mode!=='verified-ci')throw Error('Invalid builder preparation mode');
      const ciAdmission=mode==='verified-ci'?ciExpected(cfg,job,plan,io,nodeRuntime,npmVersion):undefined;
      let ci:VerifiedCI|undefined,ciDeadline:number|undefined;
      const ciNow=io.ciNow||(()=>performance.now());
      if(ciAdmission){
        assertNoCIFailure(ciAdmission.config,{jobId:job.id,releaseId:id,commit:plan.commit});
        try{ci=loadAdmittedCI(ciAdmission);}catch(error){if(!ciAdmission.config.gateway||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(!ci&&ciAdmission.config.gateway){
          const gateway=ciAdmission.config.gateway;ciDeadline=ciNow()+gateway.timeoutMs;update({phase:'notifying-ci-gateway'});
          try{await (io.notifyCI||notifyCIGateway)(gateway,{jobId:job.id,releaseId:id});}catch{log('CI gateway notification outcome uncertain; waiting for actual evidence without replay.');}
        }
      }
      const cache = new DependencyCache(join(cfg.builder.root, 'dependency-cache'), copyReleaseTree);
      update({ phase: 'dependency-cache-restore' });
      const hit = cache.restore(key, stage, cfg.build, io.chown || chownSync);
      update({ dependencyCache: { key, hit: !!hit, bytes: hit?.bytes } });
      if (!hit) {
        update({ phase: 'dependency-install' });
        io.build('/usr/bin/npm', ['ci', '--ignore-scripts'], stage, cfg);
        if (plan.native.length) { update({ phase: 'dependency-native-rebuild' }); io.build('/usr/bin/npm', ['rebuild', ...plan.native, '--ignore-scripts=false'], stage, cfg); }
        // Publish before any source-controlled check/build/test can write dependencies.
        update({ phase: 'dependency-cache-publish' });
        const published = cache.publish(key, stage);
        // Discard only roots admitted by publication, then use exactly the warm
        // restore boundary. No installer inode reaches application commands/sealing.
        update({ phase: 'dependency-cache-cold-restore' });
        removePublishedDependencies(stage, published.paths);
        const restored = cache.restore(key, stage, cfg.build, io.chown || chownSync);
        if (!restored) throw Error('Published dependency artifact missing during cold restore');
        update({ dependencyCache: { key, hit: false, bytes: restored.bytes } });
      }
      cache.retain(key);
      log(`Dependency artifact ${key}: ${hit ? 'verified hit' : 'installed, published and verified-restored'}`);
      if(ciAdmission&&!ci){
        update({phase:'waiting-ci'});
        while(!ci){
          assertNoCIFailure(ciAdmission.config,{jobId:job.id,releaseId:id,commit:plan.commit});
          if(ciDeadline===undefined||ciNow()>=ciDeadline)throw Error('Timed out waiting for verified CI evidence; production unchanged');
          try{ci=loadAdmittedCI(ciAdmission);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          if(ci)break;
          await (io.ciPause||(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(Math.min(1_000,ciDeadline-ciNow()));
        }
      }
      if(ci){
        if(ciAdmission)assertNoCIFailure(ciAdmission.config,{jobId:job.id,releaseId:id,commit:plan.commit});
        stableBaseline();update({phase:'verified-ci-import'});importCIOutputs(stage,ci);assertCIProtectedBytes(stage,cfg.prod,protectedCompiledPaths);
        request.ciImport=freezeCIProof(dir,ci,bundleSha256);atomic(join(dir,'request.json'),request);update({ciImport:request.ciImport});
        log(`Imported verified CI run ${request.ciImport.runId} attempt ${request.ciImport.runAttempt}; target dependencies remain local.`);
      }else{
      update({ phase: 'checks-tests-build' }); log('Running shared/backend/frontend/phone checks, tests and build.');
      for (const [phase, args] of [
        ['shared-build', ['run', 'build', '--workspace=packages/shared']],
        ['checks', ['run', 'check']], ['build', ['run', 'build']], ['tests', ['run', 'test']],
      ] as const) { update({ phase }); io.build('/usr/bin/npm', [...args], stage, cfg); }
      }
      update({ phase: 'sealing' });
      verifyExactSource(stage, job, plan, io);
      const runtime = [...new Set([...runtimePaths(stage), ...runtimePaths(cfg.prod)])]; for (const path of artifacts) if (!existsSync(join(stage, path))) throw new Error(`Missing runtime artifact: ${path}`);
      mkdirSync(sealed, { mode: 0o700 });
      for (const path of plan.paths) { if (runtime.some(p => path === p || path.startsWith(p + '/'))) continue; copyReleaseTree(join(stage, path), join(sealed, path), stage); }
      if (!plan.paths.includes('package-lock.json')) writeFileSync(join(sealed, 'package-lock.json'), plan.lock, { mode: 0o644 });
      for (const path of runtime) if (existsSync(join(stage, path))) copyReleaseTree(join(stage, path), join(sealed, path), stage);
      const changes = [...new Set([...plan.changed.filter(p => !runtime.some(r => p === r || p.startsWith(r + '/'))), ...runtime, 'package-lock.json'])];
      atomic(join(dir, 'manifest.json'), { bundleSha256, ...(request.ciImport?{ciImport:request.ciImport}:{}), affected: changes, sealedDigest: identityDigest(sealed, changes), baselineDigest: identityDigest(cfg.prod, changes) });
      stableBaseline(); update({ status: 'prepared', phase: 'ready' }); terminalLog('Release prepared. Production has not changed.');
    } else if (operation === 'deploy') {
      update({ status: 'deploying', phase: 'preflight' });
      const fresh = eligible(store.get(job.id)!, cfg, io); if (fresh.commit !== plan.commit || fresh.tree !== plan.tree || fresh.lock !== plan.lock) throw new Error('Builder ref/commit changed after preparation');
      pinnedBundle(cfg, record, request);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); affected = manifest.affected;
      if (identityDigest(sealed, affected) !== manifest.sealedDigest || identityDigest(cfg.prod, affected) !== manifest.baselineDigest) throw new Error('Prepared release or live dependencies changed');
      await health(); stableBaseline(); update({ pm2Identity: pm2Identity(cfg, io) });
      for (const path of affected) noSymlinkAncestor(cfg.prod, path);
      update({ phase: 'release-backup' });
      mkdirSync(previous, { mode: 0o700 });
      prior = affected.map(path => ({ path, existed: existsSync(join(cfg.prod, path)) }));
      for (const entry of prior) if (entry.existed) copyReleaseTree(join(cfg.prod, entry.path), join(previous, entry.path), cfg.prod);
      atomic(join(previous, 'restore.json'), { prior, base: plan.base, commit: plan.commit, digest: identityDigest(previous, affected), current: existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, 'utf8')) : null });
      // No source/dependency mutations until after preflight and the complete release backup.
      update({ phase: 'stopping' }); touched = true; run('/usr/bin/pm2', ['stop', cfg.app]); stopped = true;
      assertStopped(cfg, io); stableBaseline();
      update({ phase: 'final-database-backup' });
      run('/usr/bin/sqlite3', [cfg.sqlite, `.backup '${join(previous, 'database.sqlite').replace(/'/g, "''")}'`]);
      if (plan.migrations.length) { update({ phase: 'additive-migrations' }); migrateAdditive(cfg.sqlite, plan.migrations); }
      update({ phase: 'promoting' });
      for (const path of affected) replace(join(sealed, path), join(cfg.prod, path), io, sealed);
      // Import the exact committed object, then atomically compare-and-set only its admitted branch.
      pinnedBundle(cfg, record, request);
      run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', join(dir, 'source.bundle'), 'HEAD']);
      run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', 'HEAD', plan.commit, plan.base]);
      run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--mixed', plan.commit]);
      update({ phase: 'restarting' }); started = true; run('/usr/bin/pm2', ['restart', cfg.app]);
      update({ phase: 'health-verification' });
      const verified = await health();
      if (git(io, cfg.prod, ['rev-parse', 'HEAD']) !== plan.commit || git(io, cfg.prod, ['diff', '--name-only', 'HEAD'])) throw new Error('Promoted source identity mismatch');
      moveSource(plan.base, plan.commit);
      atomic(join(cfg.state, 'builder-current.json'), { id, commit: plan.commit, digest: identityDigest(cfg.prod, affected), affected });
      update({ status: 'deployed', phase: 'healthy', health: verified, database: plan.migrations.length ? 'Expanded schema retained on code rollback; later writes are preserved.' : 'Live database preserved.' });
      terminalLog('Deployment healthy after three stable PM2/HTTP checks. Previous source and dependencies retained.');
    } else {
      update({ status: 'rolling_back', phase: 'rollback-preflight' });
      assertBuilderBaseline(cfg.builder, plan.commit, (cwd, args) => git(io, cwd, args));
      const current = JSON.parse(readFileSync(join(cfg.state, 'builder-current.json'), 'utf8'));
      if (current.id !== id || git(io, cfg.prod, ['diff', '--name-only', 'HEAD']) || git(io, cfg.prod, ['rev-parse', 'HEAD']) !== plan.commit || identityDigest(cfg.prod, current.affected) !== current.digest) throw new Error('Latest live release identity mismatch');
      const restore = JSON.parse(readFileSync(join(previous, 'restore.json'), 'utf8')); prior = restore.prior; affected = current.affected;
      if (identityDigest(previous, affected) !== restore.digest) throw new Error('Retained previous release identity mismatch');
      assertRollbackIdentity(cfg, io, record); update({ phase: 'rollback-stopping' });
      run('/usr/bin/pm2', ['stop', cfg.app]); stopped = true; assertStopped(cfg, io);
      const safety = join(dir, `before-rollback-${Date.now()}`); mkdirSync(safety, { mode: 0o700 });
      for (const path of affected) if (existsSync(join(cfg.prod, path))) copyReleaseTree(join(cfg.prod, path), join(safety, path), cfg.prod);
      run('/usr/bin/sqlite3', [cfg.sqlite, `.backup '${join(safety, 'database.sqlite').replace(/'/g, "''")}'`]);
      update({ phase: 'restoring-previous-release' }); touched = true;
      for (const entry of prior) replace(join(previous, entry.path), join(cfg.prod, entry.path), io, previous);
      run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', 'HEAD', plan.base, plan.commit]);
      run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--mixed', plan.base]);
      started = true; run('/usr/bin/pm2', ['restart', cfg.app]); const verified = await health();
      restoreSource();
      restoreMarker(restore);
      update({ status: 'rolled_back', phase: 'healthy', health: verified, rollback: 'Explicit previous-release rollback verified; database and later writes retained.' }); terminalLog('Previous release restored and healthy.');
    }
  } catch (error) {
    safeToUnlock = false;
    recoveryUpdate({ error: redact(String(error)).slice(0, 6000), phase: 'failed' });
    if (operation === 'deploy' && touched) {
      try {
        run('/usr/bin/pm2', ['stop', cfg.app]); assertStopped(cfg, io);
        const restore = JSON.parse(readFileSync(join(previous, 'restore.json'), 'utf8'));
        if (identityDigest(previous, affected) !== restore.digest) throw new Error('Retained previous release identity mismatch');
        for (const entry of prior) replace(join(previous, entry.path), join(cfg.prod, entry.path), io, previous);
        const head = git(io, cfg.prod, ['rev-parse', 'HEAD']);
        if (head !== plan.base && head !== plan.commit) throw new Error('Production ref changed during rollback');
        if (head === plan.commit) run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', 'HEAD', plan.base, plan.commit]);
        run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'reset', '--mixed', plan.base]);
        // Additive expansion is backward compatible. Never replace a live DB with an older snapshot.
        run('/usr/bin/pm2', ['restart', cfg.app]); const verified = await health();
        restoreSource();
        restoreMarker(restore);
        recoveryUpdate({ status: 'rolled_back', phase: 'rollback-healthy', health: verified, rollback: 'Automatic code/dependency rollback verified; expanded database and writes preserved.' });
      } catch (rollbackError) { try { run('/usr/bin/pm2', ['stop', cfg.app]); } catch {} recoveryUpdate({ status: 'recovery_required', rollback: redact(String(rollbackError)) }); }
    } else if (operation === 'rollback' && (touched || stopped)) {
      try { run('/usr/bin/pm2', ['stop', cfg.app]); } catch {} recoveryUpdate({ status: 'recovery_required', rollback: 'Retained current backup and previous release need inspection; database was not restored.' });
    } else recoveryUpdate({ status: operation === 'rollback' ? 'deployed' : 'failed' });
    try { log(`Release operation failed: ${record.error}. ${record.rollback || 'Production source unchanged.'}`); } catch { /* metadata is the durable error fallback */ }
  } finally {
    // Uncertain operations keep the shared lock, backups, stage and request. Never replay automatically.
    if (safeToUnlock && ['prepared', 'deployed', 'rolled_back', 'failed'].includes(record.status)) {
      // Check lock ownership before any deletion. Cleanup errors cannot change terminal metadata.
      assertLock(cfg, id);
      const cleanup = (action: () => void) => {
        try { action(); } catch (error) {
          const message = `Artifact cleanup failed: ${redact(String(error))}`;
          try { log(message); } catch { console.error(message); }
        }
      };
      cleanup(() => cleanupDirectory(cfg.staging, `builder-${id}`, /^builder-[a-f0-9]{64}$/));
      if (record.status !== 'prepared') cleanup(() => cleanupDirectory(dir, 'release', /^release$/));
      if (operation === 'deploy' && record.status === 'deployed' && record.phase === 'healthy') cleanup(() => {
        const current = JSON.parse(readFileSync(currentPath, 'utf8'));
        if (current.id !== id || current.commit !== record.commit) throw new Error('Current release marker mismatch during cleanup');
        cleanupDirectory(cfg.backup, `builder-${id}`, /^builder-[a-f0-9]{64}$/, false);
        for (const name of readdirSync(cfg.backup)) if (/^builder-[a-f0-9]{64}$/.test(name) && name !== `builder-${id}`) {
          cleanup(() => cleanupDirectory(cfg.backup, name, /^builder-[a-f0-9]{64}$/));
        }
      });
      unlock(cfg, id);
    }
    store.close();
  }
}
function pm2Identity(cfg: ReleaseConfig, io: ReleaseIO): string {
  const list = JSON.parse(String(io.run('/usr/bin/pm2', ['jlist'], cfg.prod)));
  const apps = Array.isArray(list) ? list.filter(p => p.name === cfg.app) : [];
  const app = apps[0], env = app?.pm2_env;
  if (apps.length !== 1 || !['online', 'errored', 'stopped'].includes(env?.status) || !env.pm_exec_path || !env.pm_cwd || !env.exec_interpreter) throw new Error('PM2 application identity unavailable');
  return hash(JSON.stringify({ name: app.name, id: app.pm_id, script: env.pm_exec_path, cwd: env.pm_cwd, interpreter: env.exec_interpreter, uid: env.uid ?? null, gid: env.gid ?? null }));
}
function assertRollbackIdentity(cfg: ReleaseConfig, io: ReleaseIO, record: ReleaseRecord): void {
  if (!record.pm2Identity || pm2Identity(cfg, io) !== record.pm2Identity) throw new Error('Rollback PM2 application identity changed');
}
function verifyExactSource(root: string, job: BuilderJob, plan: ReleasePlan, io: ReleaseIO): void {
  for (const entry of io.git(job.workspace, ['ls-tree', '-rz', '--full-tree', plan.commit]).toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry); if (!match) throw new Error('Unsupported source tree');
    const path = join(root, match[3]); noSymlinkAncestor(root, match[3]); const stat = lstatSync(path);
    if (!stat.isFile() || !!(stat.mode & 0o111) !== (match[1] === '100755')) throw new Error('Build changed committed source mode/type');
    const bytes = readFileSync(path), actual = createHash(match[2].length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== match[2]) throw new Error('Build/archive changed committed source bytes');
  }
}
function ciExpected(cfg:ReleaseConfig,job:BuilderJob,plan:ReleasePlan,io:ReleaseIO,nodeRuntime:string,npm:string):CIExpected {
  if(cfg.ci?.mode!=='verified-ci')throw Error('Verified CI mode is not configured');
  const actual=JSON.parse(nodeRuntime);
  const runtime:CIRuntime={node:'v'+actual.versions.node,modules:actual.versions.modules,platform:actual.platform,arch:actual.arch,glibc:actual.libc,npm};
  if(Object.values(runtime).some(value=>typeof value!=='string'||!value)||runtime.platform!=='linux')throw Error('Invalid target CI runtime fingerprint');
  return {config:cfg.ci,job,plan,baselineManifest:io.git(job.workspace,['show',`${plan.base}:package.json`]),runtime};
}
/** Authenticated root SSH preview only. No release, status, ref or authority is created. */
export function previewBuilderCIAdmission(root:string,jobId:string,cfg=releaseConfig(true),io=releaseIO):object {
  if(process.getuid?.()!==0||cfg.builder.root!==root)throw Error('Root CI admission preview required');
  assertJobId(jobId);if(!lstatSync(root).isDirectory())throw Error('Builder root missing');privateDirectory(root);const dbPath=join(root,'builder.sqlite'),stat=lstatSync(dbPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||stat.nlink!==1)throw Error('Unsafe builder database');
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    const job=db.prepare('SELECT * FROM builder_jobs WHERE id = ?').get(jobId) as BuilderJob|undefined;if(!job)throw Error('Builder job not found');
    const plan=eligible(job,cfg,io);
    const target=String(io.run('/usr/bin/env',['node','-p','JSON.stringify({versions:process.versions,platform:process.platform,arch:process.arch,libc:process.report.getReport().header.glibcVersionRuntime||null})'],cfg.prod));
    const npm=String(io.run('/usr/bin/npm',['--version'],cfg.prod)).trim();const expected=ciExpected(cfg,job,plan,io,target,npm);
    return {schema:1,jobId,owner:{thread:job.ownerThread,session:job.ownerSession,audience:'owner'},plan,planSha256:ciSha(JSON.stringify(plan)),source:expectedCISource(expected),runtime:expected.runtime,workflow:{repositoryId:expected.config.repositoryId,path:expected.config.workflowPath,commit:expected.config.workflowCommit}};
  }finally{db.close();}
}
/** Read the active sealed request used by the worker, never a caller-supplied plan. */
export function previewBuilderCIRequest(root:string,releaseId:string,cfg=releaseConfig(),io=releaseIO):object {
  if(process.getuid?.()!==0||root!==cfg.builder.root||!/^[a-f0-9]{64}$/.test(releaseId))throw Error('Root active CI request preview required');
  if(!lstatSync(root).isDirectory())throw Error('Builder root missing');privateDirectory(root);
  const dir=releaseDir(cfg,releaseId);if(!lstatSync(dir).isDirectory())throw Error('Release missing');const request=readRequest(root,releaseId);
  if(request.operation!=='prepare'||request.config.builder.root!==root||request.config.prod!==cfg.prod||request.config.ci?.mode!=='verified-ci')throw Error('Release is not an active CI preparation');
  const dbPath=join(root,'builder.sqlite'),st=lstatSync(dbPath);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.nlink!==1)throw Error('Unsafe builder database');
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    const row=db.prepare('SELECT data FROM builder_deployments WHERE id = ?').get(releaseId) as {data:string}|undefined;if(!row)throw Error('Release not found');const record=JSON.parse(row.data) as ReleaseRecord;
    if(record.id!==releaseId||record.status!=='preparing'||record.jobId!==request.job.id||record.bundleSha256!==request.bundleSha256||!record.bundleSha256)throw Error('Active CI release identity mismatch');
    const actualWorker=record.worker&&io.inspect(record.worker.pid);
    if(!actualWorker||!record.worker||actualWorker.starttime!==record.worker.starttime||actualWorker.pgid!==record.worker.pgid||actualWorker.commandHash!==record.worker.commandHash)throw Error('Active CI release worker identity is uncertain');
    assertLock(request.config,releaseId);
    const job=db.prepare('SELECT * FROM builder_jobs WHERE id = ?').get(record.jobId) as BuilderJob|undefined;if(!job)throw Error('Builder job missing');
    const plan=eligible(job,request.config,io);if(ciSha(JSON.stringify(plan))!==ciSha(JSON.stringify(request.plan)))throw Error('Active CI plan drift');
    const bundlePath=join(dir,'source.bundle'),fd=openSync(bundlePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let digest:string;
    try{const b=fstatSync(fd);if(!b.isFile()||b.uid!==0||b.nlink!==1||(b.mode&0o777)!==0o600||b.size>512*1024*1024)throw Error('Unsafe active source bundle');digest=ciSha(readFileSync(fd));}finally{closeSync(fd);}
    if(digest!==record.bundleSha256)throw Error('Active source bundle digest mismatch');
    const target=String(io.run('/usr/bin/env',['node','-p','JSON.stringify({versions:process.versions,platform:process.platform,arch:process.arch,libc:process.report.getReport().header.glibcVersionRuntime||null})'],request.config.prod));
    const npm=String(io.run('/usr/bin/npm',['--version'],request.config.prod)).trim(),expected=ciExpected(request.config,job,plan,io,target,npm);
    return {schema:1,releaseId,jobId:job.id,owner:{thread:job.ownerThread,session:job.ownerSession,audience:'owner'},plan,planSha256:ciSha(JSON.stringify(plan)),source:expectedCISource(expected),runtime:expected.runtime,workflow:{repositoryId:expected.config.repositoryId,path:expected.config.workflowPath,commit:expected.config.workflowCommit},inbox:expected.config.inbox,bundle:{path:bundlePath,sha256:digest},status:record.status,phase:record.phase};
  }finally{db.close();}
}
function assertStopped(cfg: ReleaseConfig, io: ReleaseIO): void {
  const list = JSON.parse(String(io.run('/usr/bin/pm2', ['jlist'], cfg.prod)));
  const apps = Array.isArray(list) ? list.filter(p => p.name === cfg.app) : [];
  if (apps.length !== 1 || apps[0].pm2_env?.status !== 'stopped' || apps[0].pid > 0) throw new Error('PM2 application must be stopped before final snapshot/migration');
}
export function migrateAdditive(path: string, migrations: ReleasePlan['migrations']): void {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS builder_release_migrations (path TEXT PRIMARY KEY, digest TEXT NOT NULL)');
      for (const migration of migrations) {
        const before = db.prepare('SELECT digest FROM builder_release_migrations WHERE path = ?').get(migration.path) as { digest: string } | undefined;
        if (before) { if (before.digest !== migration.digest) throw new Error('Migration ledger digest mismatch'); continue; }
        for (const statement of additiveSql(migration.sql)) db.exec(statement);
        db.prepare('INSERT INTO builder_release_migrations(path,digest) VALUES (?,?)').run(migration.path, migration.digest);
      }
    })();
  } finally { db.close(); }
}
/** Optional manual-UI compare condition; autonomous tools retain job-id-only standing authority. */
export function assertExpectedRelease(store: ReturnType<typeof openBuilderStore>, jobId: string, expected: unknown): void {
  if (expected === undefined) return;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Invalid release confirmation');
  const value = expected as Record<string, unknown>, current = store.deployment(jobId);
  const actual = { id: current?.id || null, status: current?.status || 'not_prepared', commit: current?.commit || '', base: current?.base || '' };
  if (Object.keys(value).length !== 4 || Object.entries(actual).some(([key, actual]) => value[key] !== actual)) throw new Error('Release changed since confirmation. Refresh and confirm the current release.');
}
export async function builderReleaseAction(action: string, args: Record<string, unknown>, owner: BuilderOwner, cfg = releaseConfig(), launchWorker = startDetachedWorker): Promise<object> {
  if (owner.audience !== 'owner' || !owner.thread || !owner.session) throw new Error('Trusted owner required');
  assertJobId(args.id); const store = openBuilderStore(cfg.builder.root);
  try {
    const job = store.get(args.id); if (!job) throw new Error('Builder job not found');
    let record = store.deployment(job.id);
    if (record && ['preparing', 'deploying', 'rolling_back'].includes(record.status) && (record.worker ? !matchesProcess(record.worker) : Date.now() - Date.parse(record.updated) > 15_000)) {
      record = { ...record, status: 'recovery_required', error: 'Detached release worker missing or identity changed; inspect retained state before recovery.', updated: new Date().toISOString() }; store.saveRelease(record);
    }
    if (action === 'deploy_status') return record ? publicRelease(record) : { status: 'not_prepared', jobId: job.id };
    if (action === 'deploy_logs') return record ? readEvents(join(releaseDir(cfg, record.id), 'events.jsonl'), Number(args.cursor || 0)) : { events: [], cursor: 0 };
    if (action === 'prepare_deploy') {
      let reprepareBundle = false;
      if (record?.status === 'prepared') { try { pinnedBundle(cfg, record, readRequest(cfg.builder.root, record.id)); } catch { reprepareBundle = true; } }
      if (record && record.status !== 'failed' && !reprepareBundle) { assertExpectedRelease(store, job.id, args.expected); return publicRelease(record); }
      // Resolve external CI configuration only for a genuinely new preparation.
      // Diagnostics, idempotent replies, deploy of frozen evidence and rollback
      // must remain usable if the current inbox/credential has disappeared.
      if(cfg.ci===undefined)cfg={...cfg,ci:ciConfiguration(cfg.builder.root)};
      const plan = eligible(job, cfg), now = new Date().toISOString();
      record = { id: randomBytes(32).toString('hex'), jobId: job.id, status: 'preparing', commit: plan.commit, base: plan.base, tree: plan.tree, phase: 'queued', created: now, updated: now };
      privateDirectory(join(cfg.builder.root, 'deployments')); const dir = releaseDir(cfg, record.id); privateDirectory(dir);
      lock(cfg, record);
      try { assertExpectedRelease(store, job.id, args.expected); store.saveRelease(record); atomic(join(dir, 'request.json'), { config: cfg, plan, job, operation: 'prepare' }); }
      catch (error) { unlock(cfg, record.id); throw error; }
    } else {
      if (!record) throw new Error('Prepare the builder release first');
      if (action === 'deploy' && record.status !== 'prepared') { if (args.expected !== undefined) assertExpectedRelease(store, job.id, args.expected); return publicRelease(record); }
      if (action === 'rollback' && record.status !== 'deployed') throw new Error('No successful retained deployment available to roll back');
      if (!['deploy', 'rollback'].includes(action)) throw new Error('Unknown release operation');
      if (action === 'rollback') {
        const current = JSON.parse(readFileSync(join(cfg.state, 'builder-current.json'), 'utf8')); if (current.id !== record.id) throw new Error('Only the latest successful builder deployment can be rolled back');
      }
      const request = readRequest(cfg.builder.root, record.id);
      if (action === 'deploy') pinnedBundle(cfg, record, request);
      lock(cfg, record);
      try {
        assertExpectedRelease(store, job.id, args.expected);
        atomic(join(releaseDir(cfg, record.id), 'request.json'), { ...request, operation: action });
        record = { ...record, worker: undefined, status: action === 'deploy' ? 'deploying' : 'rolling_back', phase: 'queued', reason: typeof args.reason === 'string' ? redact(args.reason).slice(0, 500) : undefined, updated: new Date().toISOString() }; store.saveRelease(record);
      } catch (error) { unlock(cfg, record.id); throw error; }
    }
    const worker = fileURLToPath(new URL('./code-deployment-worker.js', import.meta.url));
    // Same compiled launcher and root-owned readiness protocol as deploy_code; fixed request only.
    const ready = join(cfg.state, `${record.id}.ready`); if (existsSync(ready)) rmSync(ready);
    await launchWorker(worker, record.id, cfg.state, undefined, 8000, { args: ['--builder-launch', record.id, cfg.builder.root], env: safeEnv('/root') });
    return publicRelease(store.release(record.id)!);
  } finally { store.close(); }
}
export async function builderReleaseTool(action: string, args: Record<string, unknown>, ctx?: BeltContext) {
  try { return { ok: true, result: JSON.stringify(await builderReleaseAction(action, args, builderOwner(ctx))) }; }
  catch (error) { return { ok: false, result: JSON.stringify({ error: redact(String(error)) }) }; }
}
export function builderReleaseReady(root: string, id: string): void { const request = readRequest(root, id), store = openBuilderStore(root); try { const record = store.release(id); if (!record) throw new Error('Release missing'); store.saveRelease({ ...record, worker: processIdentity(process.pid) || undefined, updated: new Date().toISOString() }); workerReady(id, request.config.state); } finally { store.close(); } }
