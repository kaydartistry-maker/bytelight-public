#!/usr/bin/env node
/** Exceptional one-time ROOT bootstrap. Execution requires a post-commit plan hash.
 * No application imports, shell commands, secret output or configurable live paths. */
import * as fs from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activate, recover } from './boss-activation-core.mjs';
export const BASE = 'a2f705e80f5eec26798a8cbdd530d837b2e2c142';
export const FIXED = Object.freeze({ source: '/srv/bytelight-release', prod: '/srv/bytelight-public', state: '/var/lib/bytelight-code', staging: '/var/lib/bytelight-staging', backups: '/var/backups/bytelight-code', builder: '/var/lib/bytelight-builder', jobs: '/var/lib/bytelight-builder/jobs', work: '/srv/bytelight-builder-jobs', repo: '/srv/bytelight-builder-source', home: '/srv/bytelight-codex-home', plan: '/tmp/boss-daddy-activation-plan.json', health: 'http://127.0.0.1:3002/api/health', app: 'bytelight' });
export const PUBLIC = Object.freeze({ BYTELIGHT_BUILDER_ENABLED: 'true', BYTELIGHT_BUILDER_DEPLOY_ENABLED: 'true', BYTELIGHT_BUILDER_ROOT: FIXED.jobs, BYTELIGHT_BUILDER_WORK_ROOT: FIXED.work, BYTELIGHT_BUILDER_SOURCE: FIXED.repo, BYTELIGHT_BUILDER_BASE: 'deployed', BYTELIGHT_CODEX_UID: '995', BYTELIGHT_CODEX_GID: '986', BYTELIGHT_CODEX_HOME: FIXED.home, BYTELIGHT_BUILD_UID: '994', BYTELIGHT_BUILD_GID: '985', BYTELIGHT_CODE_PRODUCTION: FIXED.prod, BYTELIGHT_CODE_STATE_DIR: FIXED.state, BYTELIGHT_CODE_STAGING_DIR: FIXED.staging, BYTELIGHT_CODE_BACKUP_DIR: FIXED.backups, BYTELIGHT_CODE_SQLITE_PATH: join(FIXED.prod, 'data/bytelight.db'), BYTELIGHT_CODE_PM2_APP: FIXED.app, BYTELIGHT_CODE_HEALTH_URL: FIXED.health, BYTELIGHT_BUILDER_TIMEOUT_MS: '1200000' });
const ARTIFACTS = ['node_modules', 'packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const present = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function cleanEnv(home = '/root') { return { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', PM2_HOME: '/root/.pm2', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }; }
function run(file, args, cwd = '/', extra = {}) {
  try { return execFileSync(file, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...extra }); }
  catch (cause) { const error = new Error('COMMAND_FAILED_' + file.split('/').at(-1).toUpperCase()); error.diagnostic = failureDiagnostic(cause); if (file === '/usr/bin/pm2') error.diagnostic.stdoutTail = ''; throw error; }
}
// Only fixed stage commands use this diagnostic path; never record environment/argv.
export function redactCommandTail(value) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [REDACTED]')
    .replace(/(["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-8192);
}
export function failureDiagnostic(error) {
  if (error.diagnostic) return error.diagnostic;
  return { exitCode: Number.isInteger(error.status) ? error.status : null,
    signal: typeof error.signal === 'string' ? error.signal : null,
    code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null,
    failureCode: /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : null,
    stderrTail: redactCommandTail(error.stderr), stdoutTail: redactCommandTail(error.stdout) };
}
export function effectStep(operation, invoke, persist, detail = {}) {
  if (!/^[a-z][a-z.-]{0,63}$/.test(operation)) fail('INVALID_EFFECT_LABEL');
  const started = Date.now();
  const event = status => ({ operation, status, started, ...(['running'].includes(status) ? {} : { finished: Date.now() }), ...detail });
  persist(event('running'));
  try { const value = invoke(); persist(event('succeeded')); return value; }
  catch (error) { persist({ ...event('failed'), ...failureDiagnostic(error) }); throw error; }
}
export async function effectPhase(operation, invoke, persist, { safety = false } = {}) {
  const started = Date.now();
  const record = value => { try { persist(value); } catch (error) { if (!safety) throw error; } };
  record({ operation, status: 'running', started });
  try { const value = await invoke(); record({ operation, status: 'succeeded', started, finished: Date.now() }); return value; }
  catch (error) { record({ operation, status: 'failed', started, finished: Date.now(), ...failureDiagnostic(error) }); throw error; }
}
export function createSourceBundle(source, target, bundle, gitCommand = git) {
  if (gitCommand(source, ['rev-parse', 'HEAD']) !== target) fail('BUNDLE_SOURCE_DRIFT');
  gitCommand(source, ['bundle', 'create', bundle, 'HEAD']); fs.chmodSync(bundle, 0o600);
  if (gitCommand(source, ['bundle', 'list-heads', bundle]) !== `${target} HEAD` || gitCommand(source, ['rev-parse','HEAD']) !== target) fail('BUNDLE_TARGET_DRIFT');
}
export function promoteTree({ prod, sealed, bundle, affected, base, target, tree, ref, stopped, gitCommand = git, replace = replaceTree, trace = (_name, fn) => fn() }) {
  trace('promote.verify', () => { stopped(); if (gitCommand(prod, ['rev-parse','HEAD']) !== base || gitCommand(prod, ['symbolic-ref','HEAD']) !== ref || gitCommand(prod, ['diff','--name-only','HEAD'])) fail('REF_RACE'); });
  const category = p => ARTIFACTS.some(a => p === a || p.startsWith(a+'/')) || /\/node_modules$/.test(p) ? 'runtime' : /(^|\/)(package.json|package-lock.json)$/.test(p) ? 'manifest' : 'source';
  for (const kind of ['source','manifest','runtime']) {
    const paths = affected.filter(p => category(p) === kind), progress = { category: kind, total: paths.length, completed: 0, item: 0 };
    trace('promote.copy-' + kind, () => { for (const p of paths) { safeRelative(p); progress.item++; replace(join(sealed,p),join(prod,p),sealed,prod); progress.completed++; } }, progress);
  }
  trace('promote.fetch', () => gitCommand(prod, ['fetch','--no-tags',bundle,target]));
  trace('promote.object', () => { if (gitCommand(prod, ['rev-parse',target+'^{tree}']) !== tree) fail('IMPORTED_TREE_MISMATCH'); });
  trace('promote.cas', () => gitCommand(prod, ['update-ref',ref,target,base]));
  trace('promote.reset', () => gitCommand(prod, ['reset','--mixed',target]));
}
export function restoreTree({ prod, backupTree, prior, base, target, ref, stopped, gitCommand = git, replace = replaceTree, trace = (_name, fn) => fn() }) {
  trace('restore.verify', () => { stopped(); const head = gitCommand(prod,['rev-parse','HEAD']); if (![base,target].includes(head) || gitCommand(prod,['symbolic-ref','HEAD']) !== ref) fail('ROLLBACK_REF_DRIFT'); });
  const progress = { category: 'prior-inventory', total: prior.length, completed: 0, item: 0 };
  trace('restore.copy', () => { for (const p of prior) { safeRelative(p.path); progress.item++; replace(join(backupTree,p.path),join(prod,p.path),backupTree,prod,true); progress.completed++; } }, progress);
  trace('restore.cas', () => { const head=gitCommand(prod,['rev-parse','HEAD']); if(head===target) gitCommand(prod,['update-ref',ref,base,target]); else if(head!==base) fail('ROLLBACK_REF_DRIFT'); });
  trace('restore.reset', () => gitCommand(prod,['reset','--mixed',base]));
}
export function stageCommand(phase, invoke, persist) {
  if (!['install','native-rebuild','check','build','test'].includes(phase)) fail('INVALID_COMMAND_PHASE');
  const started = Date.now();
  const command = { install: 'npm ci --ignore-scripts', 'native-rebuild': 'npm rebuild (fixed reviewed allowlist)', check: 'npm run check', build: 'npm run build', test: 'npm test' }[phase];
  persist({ phase, command, status: 'running', started });
  try {
    const output = invoke();
    persist({ phase, command, status: 'succeeded', started, finished: Date.now(), exitCode: 0 });
    return output;
  } catch (error) {
    const diagnostic = { phase, command, status: 'failed', started, finished: Date.now(),
      exitCode: Number.isInteger(error.status) ? error.status : null,
      signal: typeof error.signal === 'string' ? error.signal : null,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null,
      stderrTail: redactCommandTail(error.stderr), stdoutTail: redactCommandTail(error.stdout) };
    persist(diagnostic);
    throw new Error('STAGE_COMMAND_FAILED_' + phase.toUpperCase().replaceAll('-', '_'));
  }
}
export function appendCommandDiagnostic(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077)) fail('UNSAFE_COMMAND_LOG');
    // Append-only bounded log; the receipt always retains the latest command too.
    if (st.size + bytes.length <= 256 * 1024) { fs.writeSync(fd, bytes); fs.fsyncSync(fd); }
  } finally { fs.closeSync(fd); }
}
function git(repo, args) { return run('/usr/bin/git', ['-c', `safe.directory=${repo}`, '-c', 'core.hooksPath=/dev/null', ...args], repo).toString().trim(); }
function atomic(path, object) {
  const tmp = path + '.' + randomUUID() + '.new'; const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(object, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path); const d = fs.openSync(dirname(path), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
function privateFile(p) { const s = fs.lstatSync(p); if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o077)) fail('PRIVATE_FILE_REQUIRED'); }
function physical(p, uid = 0, mode) {
  let ancestor = dirname(p); while (ancestor !== '/') { const a=fs.lstatSync(ancestor); if(a.isSymbolicLink() || a.uid!==0 || (a.mode & 0o022)) fail('UNSAFE_DIRECTORY_ANCESTRY'); ancestor=dirname(ancestor); }
  const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== p || s.uid !== uid || (s.mode & 0o022) || (mode !== undefined && (s.mode & 0o777) !== mode)) fail('DIRECTORY_IDENTITY_MISMATCH');
}
export function safeRelative(p) { if (!p || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..') || /[\x00-\x1f]/.test(p)) fail('UNSAFE_PATH'); }
export function copyTree(from, to, root = from) {
  const st = fs.lstatSync(from); fs.mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  if (st.isSymbolicLink()) {
    const link = fs.readlinkSync(from), dest = resolve(dirname(from), link);
    if (isAbsolute(link) || (dest !== root && !dest.startsWith(root + '/'))) fail('ESCAPING_LINK');
    fs.symlinkSync(link, to);
  } else if (st.isDirectory()) {
    fs.mkdirSync(to, { mode: st.mode & 0o777 });
    for (const n of fs.readdirSync(from)) copyTree(join(from, n), join(to, n), root);
  } else if (st.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  else fail('SPECIAL_FILE');
  if (!st.isSymbolicLink()) fs.chmodSync(to, st.mode & 0o777);
}
function noLink(p, root) { let c = root; for (const part of relative(root, p).split('/')) { if (!part) continue; c = join(c, part); if (present(c) && fs.lstatSync(c).isSymbolicLink()) fail('PATH_LINK'); } }
export function replaceTree(from, to, root, productionRoot, recovering = false) {
  const next = to + '.boss-next';
  if(present(next)) { if(!recovering || fs.lstatSync(next).uid!==fs.statSync(productionRoot).uid) fail('RETAINED_PARTIAL_PROMOTION'); fs.rmSync(next,{force:true,recursive:true}); }
  noLink(to, productionRoot);
  try { if (present(from)) copyTree(from, next, root); } catch(e) { fs.rmSync(next,{force:true,recursive:true}); throw e; }
  fs.rmSync(to, { force: true, recursive: true }); if (present(next)) fs.renameSync(next, to);
}
function replace(from,to,root,recovering=false) { return replaceTree(from,to,root,FIXED.prod,recovering); }
function tracked(repo, commit) { return git(repo, ['ls-tree', '-rz', '--name-only', commit]).split('\0').filter(Boolean); }
function pm2List() { return JSON.parse(run('/usr/bin/pm2', ['jlist']).toString()); }
function appIdentity(app) { return { name: app.name, cwd: app.pm2_env.pm_cwd, script: app.pm2_env.pm_exec_path, interpreter: app.pm2_env.exec_interpreter, uid: app.pm2_env.uid ?? 0 }; }
export function selectApp(list,optional = false) { const matches = list.filter(a => a.name === FIXED.app); if(optional && matches.length===0) return undefined; if (matches.length !== 1) fail('PM2_IDENTITY'); return matches[0]; }
function currentApp(optional=false) { return selectApp(pm2List(),optional); }
export async function stableHealth(readApp, request, identity, pause = () => new Promise(r => setTimeout(r,1000))) {
  let stable = '', count = 0;
  for (let i = 0; i < 20; i++) {
    const app = readApp();
    if (JSON.stringify(appIdentity(app)) !== JSON.stringify(identity)) fail('PM2_IDENTITY_CHANGED');
    const key = app.pid + ':' + app.pm2_env.restart_time;
    try {
      if (app.pm2_env.status !== 'online' || !Number.isSafeInteger(app.pid) || app.pid<=1 || !Number.isSafeInteger(app.pm2_env.restart_time) || app.pm2_env.restart_time<0) fail('PM2_NOT_ONLINE');
      const res = await request();
      const body = await res.json(); if (!res.ok || body.status !== 'ok') fail('HEALTH');
      count = key === stable ? count + 1 : 1; stable = key;
      if (count === 3) return { samples: 3, pid: app.pid, restarts: app.pm2_env.restart_time };
    } catch { count = 0; stable = ''; }
    await pause();
  }
  fail('HEALTH_NOT_STABLE');
}
function health(identity) { return stableHealth(currentApp,()=>fetch(FIXED.health,{signal:AbortSignal.timeout(3000),redirect:'error'}),identity); }
export function priorDefinition(app) { const e=app.pm2_env; return {...e,name:FIXED.app,script:e.pm_exec_path,cwd:e.pm_cwd,interpreter:e.exec_interpreter,env:e.env || {}}; }
function verifyOperator(plan) {
  for(const [n,hash] of Object.entries(plan.scriptHashes)) {
    if(!['activate-boss-daddy.mjs','boss-activation-core.mjs'].includes(n) || sha(fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)),n)))!==hash || sha(run('/usr/bin/git',['-c',`safe.directory=${FIXED.source}`,'show',`${plan.target}:scripts/${n}`],FIXED.source))!==hash) fail('OPERATOR_SCRIPT_DRIFT');
  }
}
function runtimePaths(prod) {
  const paths = [...ARTIFACTS];
  for (const name of ['shared', 'backend', 'frontend', 'phone']) if (present(join(prod, 'packages', name, 'node_modules'))) paths.push(`packages/${name}/node_modules`);
  return paths;
}
function fingerprints() {
  return Object.fromEntries(['.env', 'ecosystem.config.cjs', 'package-lock.json'].map(p => [p, sha(fs.readFileSync(join(FIXED.prod, p)))]));
}
export function validatePlan(plan) {
  const keys = ['version','baseline','target','tree','files','changedFiles','productionFingerprints','identity','publicEnvironment','lockSha256','native','scriptHashes'];
  if (JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(keys.sort()) || plan.version !== 1 || plan.baseline !== BASE || !/^[a-f0-9]{40}$/.test(plan.target) || !/^[a-f0-9]{40}$/.test(plan.tree) || JSON.stringify(plan.publicEnvironment) !== JSON.stringify(PUBLIC)) fail('INVALID_PLAN');
  const hash = v => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
  if(!plan.scriptHashes || Object.keys(plan.scriptHashes).sort().join(',')!=='activate-boss-daddy.mjs,boss-activation-core.mjs' || !Object.values(plan.scriptHashes).every(hash)) fail('INVALID_SCRIPT_BINDING');
  if(!plan.productionFingerprints || Object.keys(plan.productionFingerprints).sort().join(',')!=='.env,ecosystem.config.cjs,package-lock.json' || !Object.values(plan.productionFingerprints).every(hash) || !hash(plan.lockSha256) || !Array.isArray(plan.changedFiles) || !Array.isArray(plan.native) || plan.native.some(n=>!['better-sqlite3','esbuild','onnxruntime-node','sharp','koffi'].includes(n))) fail('INVALID_PLAN_METADATA');
  if (!Array.isArray(plan.files) || plan.files.some(p => { try { safeRelative(p); return false; } catch { return true; } })) fail('INVALID_PLAN_PATHS');
  return plan;
}
function nativePackages(lock) {
  const allowed = { 'better-sqlite3': '11.10.0', esbuild: '0.28.1', 'onnxruntime-node': '1.21.0', sharp: '0.34.5', koffi: '3.3.3' };
  return Object.entries(allowed).filter(([n,v]) => lock.packages?.[`node_modules/${n}`]?.version === v).map(([n]) => n);
}
function exactTarget(target) {
  if (git(FIXED.source, ['rev-parse', 'HEAD']) !== target || git(FIXED.source, ['status', '--porcelain', '--untracked-files=all'])) fail('SOURCE_NOT_CLEAN_TARGET');
  if (git(FIXED.source, ['merge-base', '--is-ancestor', '9b1b8e54f2f5257faddec6fe433444719702f98b', target]) !== '') fail('TARGET_ANCESTRY');
}
export async function inspect({ requireClean = true } = {}) {
  if (process.getuid() !== 0) fail('ROOT_REQUIRED');
  for (const p of [FIXED.prod, FIXED.state, FIXED.staging, FIXED.backups]) physical(p);
  physical(FIXED.home, 995, 0o700); if(fs.statSync(FIXED.home).gid!==986) fail('CODER_HOME_GROUP');
  if (run('/usr/bin/id', ['-u', 'virelle-codex']).toString().trim() !== '995' || run('/usr/bin/id', ['-g', 'virelle-codex']).toString().trim() !== '986' || run('/usr/bin/id', ['-u', 'virelle-build']).toString().trim() !== '994' || run('/usr/bin/id', ['-g', 'virelle-build']).toString().trim() !== '985') fail('USER_IDENTITY');
  if (git(FIXED.prod, ['rev-parse', 'HEAD']) !== BASE || git(FIXED.prod, ['diff', '--name-only', 'HEAD'])) fail('PRODUCTION_BASELINE');
  const target = git(FIXED.source, ['rev-parse', 'HEAD']);
  if (requireClean) exactTarget(target);
  const identity = appIdentity(currentApp());
  if (identity.cwd !== FIXED.prod || identity.script !== join(FIXED.prod, 'packages/backend/dist/server.js') || !['node','/usr/bin/node'].includes(identity.interpreter) || ![0,'root'].includes(identity.uid)) fail('PM2_IDENTITY');
  if(fs.statSync(`/proc/${currentApp().pid}`).uid!==0) fail('PM2_PROCESS_NOT_ROOT');
  await health(identity);
  for (const p of [FIXED.builder, FIXED.work, FIXED.repo, join(FIXED.state, 'boss-ecosystem.config.cjs'), join(FIXED.state, 'deploy.lock')]) if (present(p)) fail('ACTIVATION_ALREADY_PRESENT_OR_IN_PROGRESS');
  if(run('/usr/bin/systemctl',['is-enabled','pm2-root.service']).toString().trim()!=='enabled') fail('PM2_REBOOT_SERVICE_NOT_ENABLED');
  const space = fs.statfsSync(FIXED.staging); if (space.bavail * space.bsize < 12 * 1024 ** 3) fail('INSUFFICIENT_DISK_12GIB');
  const files = tracked(FIXED.source, target);
  for (const p of files) { safeRelative(p); if (!p.endsWith('/.env.example') && p!=='.env.example' && /(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12)|data|memory-vault|logs)(\/|$)/i.test(p)) fail('PRIVATE_TARGET_PATH'); noLink(join(FIXED.prod, p), FIXED.prod); }
  const entries = git(FIXED.source, ['ls-tree', '-r', target]); if (/^(120000|160000) /m.test(entries)) fail('TARGET_LINK_OR_SUBMODULE');
  const prior = new Set(tracked(FIXED.prod, BASE));
  for (const p of files) if (!prior.has(p) && present(join(FIXED.prod, p))) fail('PRIVATE_UNTRACKED_COLLISION');
  const mainDelta=git(FIXED.source,['diff','--name-only',BASE,target,'--','packages/backend/migrations','packages/backend/src/services/db.ts','packages/backend/src/db-init.ts','packages/backend/src/services/db']).split('\n').filter(Boolean).filter(p=>!/^packages\/backend\/migrations\/builder_\d+_[^/]+\.sql$/.test(p) && p!=='packages/backend/src/services/db/builder-jobs.ts');
  if(mainDelta.length) fail('MAIN_DATABASE_CHANGE_REQUIRES_DIFFERENT_BOOTSTRAP');
  const lock = fs.readFileSync(join(FIXED.prod, 'package-lock.json'));
  const scriptHashes = Object.fromEntries(['activate-boss-daddy.mjs','boss-activation-core.mjs'].map(n => [n, sha(fs.readFileSync(join(FIXED.source, 'scripts', n)))]));
  return { version: 1, baseline: BASE, target, tree: git(FIXED.source, ['rev-parse', `${target}^{tree}`]), files, changedFiles:git(FIXED.source,['diff','--name-status',BASE,target]).split('\n').filter(Boolean), productionFingerprints: fingerprints(), identity, publicEnvironment: PUBLIC, lockSha256: sha(lock), native: nativePackages(JSON.parse(lock)), scriptHashes };
}
export function productionAdapter(plan) {
  const key = 'boss-bootstrap-' + plan.target;
  const stage = join(FIXED.staging, key), backup = join(FIXED.backups, key), sealed = join(FIXED.state, key + '.sealed');
  const receipt = join(FIXED.state, key + '.json'), lock = join(FIXED.state, 'deploy.lock');
  const overlay = join(FIXED.state, 'boss-ecosystem.config.cjs');
  let affected = [], prior = [], originalApp, created = [], healthResult, command, effect, effectFailure, lastEffectFailure;
  const commandLog = join(FIXED.state, key + ".commands.jsonl");
  let lastReceipt;
  const effectLog = join(FIXED.state, key + '.effects.jsonl');
  let safetyEffects = false;
  const writeEffect = value => {
    effect = value;
    if (value.status === 'failed') { effectFailure ??= value; lastEffectFailure = value; }
    appendCommandDiagnostic(effectLog, value);
    if (lastReceipt) atomic(receipt, { ...lastReceipt, command: command ?? lastReceipt.command, commandLog, effect, effectFailure, lastEffectFailure, effectLog });
  };
  const persistEffect = value => { try { writeEffect(value); } catch (error) { if (!safetyEffects) throw error; } };
  const trace = (name, fn, detail) => effectStep(name, fn, persistEffect, detail);
  const persistCommand = value => {
    command = value; appendCommandDiagnostic(commandLog, value);
    if (lastReceipt) atomic(receipt, { ...lastReceipt, command, commandLog, effect, effectFailure, lastEffectFailure, effectLog });
  };
  let originalRef = git(FIXED.prod, ['symbolic-ref', 'HEAD']);
  const stopped = () => { const a = currentApp(true); if(!a) return; if (a.pm2_env.status !== 'stopped' || a.pid) fail('STOP_NOT_VERIFIED'); };
  const snapshot = name => run('/usr/bin/sqlite3', [join(FIXED.prod, 'data/bytelight.db'), `.backup '${join(backup, name)}'`]);
  const ownTree = (p, uid, gid) => { for (const n of fs.readdirSync(p)) { const f = join(p,n); const st = fs.lstatSync(f); if (st.isDirectory()) ownTree(f,uid,gid); else fs.lchownSync(f,uid,gid); } fs.chownSync(p,uid,gid); };
  const sourceRef = () => {
    if(!present(join(FIXED.repo,'HEAD'))) return null;
    const refs=git(FIXED.repo,['for-each-ref','--format=%(refname):%(objectname)']);
    if(!refs) return null;
    const match=/^refs\/heads\/deployed:([a-f0-9]{40})$/.exec(refs); if(!match) fail('ROLLBACK_SOURCE_DRIFT'); return match[1];
  };
  const make = (p, uid, gid, mode) => { fs.mkdirSync(p, { mode }); created.push(p); fs.chownSync(p,uid,gid); fs.chmodSync(p,mode); };
  return {
    effect: async (name, fn, options) => {
      const previous = safetyEffects; safetyEffects = options?.safety === true;
      try { return await effectPhase(name, fn, persistEffect, options); } finally { safetyEffects = previous; }
    },
    async loadRecovery() {
      privateFile(receipt); privateFile(lock);
      const r=JSON.parse(fs.readFileSync(receipt)), l=JSON.parse(fs.readFileSync(lock));
      if(l.key!==key || r.target!==plan.target || r.tree!==plan.tree) fail('RECOVERY_BINDING');
      command=r.command; effect=r.effect; effectFailure=r.effectFailure; lastEffectFailure=r.lastEffectFailure; lastReceipt=r;
      try { process.kill(l.pid,0); fail('ORIGINAL_OPERATOR_STILL_ALIVE'); } catch(e) { if(e.code!=='ESRCH') throw e; }
      atomic(lock,{key,pid:process.pid,state:'recovering',kind:'boss-bootstrap'});
      if(!r.phases.some(p=>['stop','final-snapshot','promote','source','config','restart','health','persist'].includes(p))) return r;
      privateFile(join(backup,'inventory.json'));
      const inv=JSON.parse(fs.readFileSync(join(backup,'inventory.json')));
      if(inv.target!==plan.target || inv.baseline!==BASE || !/^refs\/heads\/[a-zA-Z0-9/_-]+$/.test(inv.originalRef)) fail('RECOVERY_INVENTORY');
      for(const x of inv.prior) { safeRelative(x.path); if(![...tracked(FIXED.prod,BASE),...plan.files,'package-lock.json',...ARTIFACTS,...['shared','backend','frontend','phone'].map(n=>`packages/${n}/node_modules`)].includes(x.path)) fail('RECOVERY_PATH'); }
      prior=inv.prior; affected=inv.affected; originalRef=inv.originalRef;
      originalApp=JSON.parse(fs.readFileSync(join(backup,'pm2-original.json')));
      created=Array.isArray(r.created)?r.created.filter(p=>[FIXED.builder,FIXED.jobs,FIXED.work,FIXED.repo,overlay].includes(p)):[];
      return r;
    },
    async verifyUntouched() { if(git(FIXED.prod,['rev-parse','HEAD'])!==BASE || git(FIXED.prod,['diff','--name-only','HEAD']) || JSON.stringify(fingerprints())!==JSON.stringify(plan.productionFingerprints)) fail('UNTOUCHED_PRODUCTION_DRIFT'); await health(plan.identity); },
    async preflight() {
      validatePlan(plan); const actual = await inspect();
      if (JSON.stringify(actual) !== JSON.stringify(plan)) fail('PLAN_DRIFT');
      verifyOperator(plan);
      for (const p of [stage,backup,sealed,receipt]) if (present(p)) fail('REPLAY_OR_RETAINED_STATE');
    },
    async lock() { const fd = fs.openSync(lock,'wx',0o600); try { fs.writeFileSync(fd, JSON.stringify({ key, pid: process.pid, kind: 'boss-bootstrap' })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
    async unlock() { if (JSON.parse(fs.readFileSync(lock)).key !== key) fail('LOCK_CHANGED'); fs.unlinkSync(lock); },
    async record(value) { if (present(lock)) { lastReceipt = { ...value, health:healthResult, created, stage, backup, sealed }; atomic(receipt,{ ...lastReceipt, command: command ?? value.command, commandLog, effect: effect ?? value.effect, effectFailure: effectFailure ?? value.effectFailure, lastEffectFailure: lastEffectFailure ?? value.lastEffectFailure, effectLog }); } },
    async stage() {
      fs.mkdirSync(stage,{mode:0o755});
      const archive = join(stage,'.source.tar'); fs.writeFileSync(archive,run('/usr/bin/git',['-c',`safe.directory=${FIXED.source}`,'archive',plan.target],FIXED.source),{mode:0o644});
      run('/usr/bin/tar',['-xf',archive,'-C',stage]); fs.unlinkSync(archive);
      if (!present(join(stage,'package-lock.json'))) fs.copyFileSync(join(FIXED.prod,'package-lock.json'),join(stage,'package-lock.json'));
      if (sha(fs.readFileSync(join(stage,'package-lock.json'))) !== plan.lockSha256) fail('LOCK_DRIFT');
      fs.mkdirSync(join(stage,'.build-home'),{mode:0o700}); ownTree(stage,994,985);
      // PID/mount namespaces: no /root, secrets, peer homes or writable host tree.
      const home = join(stage,'.build-home');
      const build = (phase, args) => stageCommand(phase, () => execFileSync('/usr/bin/setpriv',['--reuid=994','--regid=985','--clear-groups','/usr/bin/bwrap','--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent','--ro-bind','/','/','--tmpfs','/tmp','--tmpfs','/var/tmp','--tmpfs','/root','--tmpfs','/run','--tmpfs','/srv','--tmpfs',FIXED.state,'--tmpfs',FIXED.backups,'--ro-bind','/etc/resolv.conf',fs.realpathSync('/etc/resolv.conf'),'--bind',stage,stage,'--proc','/proc','--dev','/dev','--chdir',stage,'--setenv','HOME',home,'--setenv','npm_config_cache',join(home,'.npm'),'/usr/bin/npm',...args], { timeout: 30*60_000, maxBuffer: 32*1024*1024, env: { PATH:'/usr/bin:/bin', LANG:'C.UTF-8', HOME:home }, cwd: '/', stdio: ['ignore','pipe','pipe'] }), persistCommand);
      build('install',['ci','--ignore-scripts']); if(plan.native.length) build('native-rebuild',['rebuild',...plan.native,'--ignore-scripts=false']);
      build('check',['run','check']); build('build',['run','build']); build('test',['test']);
      // No descendants survive the bwrap PID namespace. Copy to root-private sealed tree.
      fs.mkdirSync(sealed,{mode:0o700});
      trace('stage.bundle', () => createSourceBundle(FIXED.source,plan.target,join(sealed,'.boss-source.bundle')));
      const runtime=[...new Set([...runtimePaths(stage),...runtimePaths(FIXED.prod)])];
      affected=[...new Set([...tracked(FIXED.prod,BASE),...plan.files,'package-lock.json',...runtime])].filter(p=>!runtime.some(q=>p!==q&&p.startsWith(q+'/')));
      for(const p of affected) {
        safeRelative(p); if(present(join(stage,p))) copyTree(join(stage,p),join(sealed,p),stage);
      }
      // Build must not modify source; compare mode/content to committed blobs.
      for(const p of plan.files) {
        const expected=run('/usr/bin/git',['-c',`safe.directory=${FIXED.source}`,'show',`${plan.target}:${p}`],FIXED.source);
        if(!fs.lstatSync(join(sealed,p)).isFile()) fail('BUILD_MODIFIED_SOURCE');
        const mode=git(FIXED.source,['ls-tree',plan.target,'--',p]).slice(0,6);
        if(!fs.readFileSync(join(sealed,p)).equals(expected) || !!(fs.statSync(join(sealed,p)).mode & 0o111)!==(mode==='100755')) fail('BUILD_MODIFIED_SOURCE');
      }
    },
    async backup() {
      if(git(FIXED.prod,['rev-parse','HEAD'])!==BASE || git(FIXED.prod,['diff','--name-only','HEAD']) || JSON.stringify(fingerprints())!==JSON.stringify(plan.productionFingerprints)) fail('PRODUCTION_DRIFT');
      fs.mkdirSync(backup,{mode:0o700});
      prior=affected.map(path=>({path,existed:present(join(FIXED.prod,path))}));
      for(const p of prior) { if(present(join(FIXED.prod,p.path)+'.boss-next')) fail('RETAINED_PARTIAL_PROMOTION'); noLink(join(FIXED.prod,p.path),FIXED.prod); if(p.existed) copyTree(join(FIXED.prod,p.path),join(backup,'tree',p.path),FIXED.prod); }
      for(const p of ['.env','ecosystem.config.cjs','bytelight.yaml']) if(present(join(FIXED.prod,p))) copyTree(join(FIXED.prod,p),join(backup,'config',p),FIXED.prod);
      if(present('/root/.pm2/dump.pm2')) copyTree('/root/.pm2/dump.pm2',join(backup,'pm2-dump.json'));
      originalApp=currentApp(); atomic(join(backup,'pm2-original.json'),originalApp);
      const e=originalApp.pm2_env;
      // Recreate only selected app; preserve original explicit environment, never print it.
      atomic(join(backup,'prior-app.json'),{apps:[priorDefinition(originalApp)]});
      atomic(join(backup,'inventory.json'),{prior,originalRef,baseline:BASE,target:plan.target,affected});
    },
    async stop() { const app=currentApp(true); if(!app) return; if(JSON.stringify(appIdentity(app))!==JSON.stringify(plan.identity)) fail('STOP_IDENTITY_CHANGED'); run('/usr/bin/pm2',['stop',FIXED.app]); stopped(); },
    async snapshot() { stopped(); snapshot('final-database.sqlite'); },
    async safetySnapshot() { stopped(); if(present(backup)) snapshot('rollback-current-database.sqlite'); },
    async promote() {
      promoteTree({ prod: FIXED.prod, sealed, bundle: join(sealed,'.boss-source.bundle'), affected, base: BASE, target: plan.target, tree: plan.tree, ref: originalRef, stopped, trace });
    },
    async source() {
      make(FIXED.builder,0,0,0o700); make(FIXED.jobs,0,0,0o700); make(FIXED.work,0,0,0o755); make(FIXED.repo,0,0,0o700);
      git(FIXED.repo,['init','--bare','--initial-branch=deployed']); trace('source.fetch', () => git(FIXED.repo,['fetch','--no-tags',join(sealed,'.boss-source.bundle'),plan.target])); git(FIXED.repo,['update-ref','refs/heads/deployed',plan.target,'0'.repeat(40)]); ownTree(FIXED.repo,995,986);
      if(git(FIXED.repo,['rev-parse','deployed'])!==plan.target) fail('SOURCE_REF');
    },
    async configure() {
      const template=`const base = require('${FIXED.prod}/ecosystem.config.cjs');\nconst publicEnv = ${JSON.stringify(PUBLIC,null,2)};\nmodule.exports = {...base, apps: base.apps.filter(a => a.name === 'bytelight').map(a => ({...a,env:{...a.env,...publicEnv}}))};\n`;
      fs.writeFileSync(overlay,template,{mode:0o600,flag:'wx'}); created.push(overlay);
    },
    async restart() { run('/usr/bin/pm2',['startOrRestart',overlay,'--only',FIXED.app,'--update-env']); },
    async health() {
      if(git(FIXED.prod,['rev-parse','HEAD'])!==plan.target || git(FIXED.prod,['diff','--name-only','HEAD']) || git(FIXED.repo,['rev-parse','deployed'])!==plan.target) fail('PROMOTED_BASELINE');
      const app=currentApp(); for(const [k,v] of Object.entries(PUBLIC)) if(app.pm2_env[k]!==v) fail('PUBLIC_ENV_NOT_ACTIVE');
      healthResult=await health(plan.identity);
      const res=await fetch('http://127.0.0.1:3002/api/builder/jobs',{signal:AbortSignal.timeout(3000)}); if(![401,403].includes(res.status)) fail('UNAUTHENTICATED_BUILDER_NOT_DENIED');
      if(!present(join(FIXED.jobs,'builder.sqlite'))) fail('BUILDER_DB_NOT_INITIALIZED');
    },
    async persist() {
      const expected=currentApp().pm2_env; run('/usr/bin/pm2',['save']);
      const saved=JSON.parse(fs.readFileSync('/root/.pm2/dump.pm2')).filter(e=>e.name===FIXED.app);
      if(saved.length!==1 || saved[0].pm_cwd!==FIXED.prod || saved[0].pm_exec_path!==plan.identity.script) fail('PM2_SAVE_IDENTITY');
      for(const k of Object.keys(PUBLIC)) if(saved[0][k]!==expected[k]) fail('PM2_ENV_NOT_DURABLE');
    },
    async restore() {
      stopped();
      { const ref=sourceRef(); if(ref && ![BASE,plan.target].includes(ref)) fail('ROLLBACK_SOURCE_DRIFT'); }
      restoreTree({ prod: FIXED.prod, backupTree: join(backup,'tree'), prior, base: BASE, target: plan.target, ref: originalRef, stopped, trace });
      if(sourceRef()===plan.target) {
         git(FIXED.repo,['update-ref','refs/heads/deployed',BASE,plan.target]);
      }
      if(present(overlay)) fs.unlinkSync(overlay);
      // Keep initialized DB/repository for inspection. Remove only exact newly-created empty dirs.
      for(const p of [...created].reverse()) if(present(p) && fs.lstatSync(p).isDirectory() && fs.readdirSync(p).length===0) fs.rmdirSync(p);
      // No main migration exists in this target; never overwrite post-start user writes.
    },
    async restartPrior() {
      if(currentApp(true)) run('/usr/bin/pm2',['delete',FIXED.app]); run('/usr/bin/pm2',['start',join(backup,'prior-app.json'),'--only',FIXED.app], '/', {env:originalApp.pm2_env.env || {HOME:'/root',PATH:'/usr/bin:/bin'}});
    },
    async healthPrior() {
      if(git(FIXED.prod,['rev-parse','HEAD'])!==BASE || JSON.stringify(fingerprints())!==JSON.stringify(plan.productionFingerprints)) fail('ROLLBACK_IDENTITY');
      await health(plan.identity);
      const env=currentApp().pm2_env;
      for(const k of Object.keys(PUBLIC)) if(env[k]!==originalApp.pm2_env[k]) fail('ROLLBACK_ENV_NOT_EXACT');
    },
  };
}
export function approvalText(plan, hash) { return `Activate Boss Daddy at exact commit ${plan.target}, tree ${plan.tree}. Reuse existing coder/build users. Create dedicated bare source, private builder state, retained worktrees and non-secret PM2 overlay; no .env edits. Stage/check/test/build before stopping bytelight, take final stopped SQLite backup, promote source/dependencies/artifacts, verify three stable health samples and owner-only API. Backups retained; failure restores old code/dependencies/PM2 environment while preserving live database writes. Expected downtime 1–3 minutes, recovery may take longer. No new external accounts/spend/OS packages/users or secret exposure/rotation. Root/PM2/config and downtime require User approval. Plan SHA256 ${hash}.\n`; }
async function main() {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--dry-run') {
    const plan=await inspect({requireClean:false});
    console.log(JSON.stringify({dryRun:true,liveEffects:false,baseline:plan.baseline,head:plan.target,tree:plan.tree,immutablePlanReady:!git(FIXED.source,['status','--porcelain','--untracked-files=all']),files:plan.files.length,identity:plan.identity,directories:[FIXED.builder,FIXED.jobs,FIXED.work,FIXED.repo],config:join(FIXED.state,'boss-ecosystem.config.cjs'),envKeys:Object.keys(PUBLIC),diskMinimumGiB:12,approvalRequired:true},null,2)); return;
  }
  if(args.length===1&&args[0]==='--generate-plan') {
    const plan=await inspect(); validatePlan(plan);
    if(present(FIXED.plan)) fail('PLAN_EXISTS'); atomic(FIXED.plan,plan); const hash=sha(fs.readFileSync(FIXED.plan));
    fs.writeFileSync('/tmp/boss-daddy-activation-approval.txt',approvalText(plan,hash),{mode:0o600,flag:'wx'}); console.log(approvalText(plan,hash)); return;
  }
  if(args.length===2&&['--execute','--recover','--execute-locked','--recover-locked'].includes(args[0])&&/^[a-f0-9]{64}$/.test(args[1])) {
    privateFile(FIXED.plan); const bytes=fs.readFileSync(FIXED.plan); if(sha(bytes)!==args[1]) fail('PLAN_HASH_MISMATCH');
    const plan=validatePlan(JSON.parse(bytes)); verifyOperator(plan);
    const operatorLock=join(FIXED.state,'boss-operator.lock');
    if(!args[0].endsWith('-locked')) {
      if(process.getuid()!==0) fail('ROOT_REQUIRED'); if(present(operatorLock)) privateFile(operatorLock);
      const fd=fs.openSync(operatorLock,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
      try { process.stdout.write(run('/usr/bin/flock',['--nonblock','/proc/self/fd/3','/usr/bin/node',fileURLToPath(import.meta.url),args[0]+'-locked',args[1]],'/',{stdio:['ignore','pipe','pipe',fd],timeout:4*60*60_000})); } finally { fs.closeSync(fd); } return;
    }
    const st=fs.fstatSync(3), expected=fs.statSync(operatorLock);
    if(st.ino!==expected.ino || st.dev!==expected.dev || st.uid!==0 || (st.mode&0o077)) fail('OPERATOR_LOCK_FD_REQUIRED');
    const adapter=productionAdapter(plan);
    let result;
    if(args[0]==='--recover-locked') { result=await recover(adapter); } else result=await activate(adapter,plan);
    console.log(JSON.stringify(result)); if(result.status!=='activated' && !(args[0]==='--recover-locked' && ['rolled_back','failed_before_stop'].includes(result.status))) process.exitCode=1; return;
  }
  fail('USAGE: --dry-run | --generate-plan | --execute EXACT_APPROVED_PLAN_SHA256 | --recover SAME_PLAN_SHA256');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error('Activation refused or failed: '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'INPUT_OR_IO_FAILURE')+'. Inspect root-private receipt and retained backup.');process.exitCode=1;});
