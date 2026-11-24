#!/usr/bin/env node
/** Native, provider-independent host tools. Stdio only; no Letta or account dependency.
 * This is an owner-authorized executor, NOT a filesystem/process security sandbox.
 * Paths are caller-chosen, subject to OS permissions and configured operator policy.
 * Jobs outlive the MCP connection; explicit stop/timeout reaps their process group.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SOURCE = path.resolve(path.dirname(SELF), '..');
const PAGE = 24_000;
const MAX_EDIT = 2 * 1024 * 1024;
const MAX_LOG = 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (value, fallback, max, min = 0) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`);
  return n;
};
function text(value, name, max = 8192) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function atomicJSON(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function smallBytes(handle, stat) {
  if (!stat.isFile()) throw new Error('Target is not a regular file');
  if (stat.size > MAX_EDIT) throw new Error(`Atomic editing supports files up to ${MAX_EDIT} bytes; use a managed command for larger files`);
  const buffer = Buffer.alloc(stat.size + 1); let length = 0;
  while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
  const after = await handle.stat();
  if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Conflict: file changed during read');
  return buffer.subarray(0, length);
}

/** The detached supervisor runs in its own process group. Never signal a stored
 * arbitrary PID: stop requests are files consumed by the owning supervisor. */
export function runWorker(directory, nonce) {
  const stateFile = path.join(directory, 'state.json');
  let state = json(stateFile);
  if (state.nonce !== nonce || state.status !== 'queued') throw new Error('Invalid job claim');
  state = { ...state, status: 'running', worker_pid: process.pid, started_at: new Date().toISOString() };
  atomicJSON(stateFile, state);
  let done = false, outputBytes = 0, totalBytes = 0, child, interval, timer;
  const output = fs.openSync(path.join(directory, 'output.log'), 'a', 0o600);
  const cleanupGroup = () => {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(process.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-process.pid, 'SIGTERM'); } catch {}
      // Keep this timer referenced: even a normally exited shell can leave
      // descendants (including children ignoring TERM) behind.
      setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(0); } }, 500);
    }
  };
  const finish = (status, code = null, signal = null, error = null) => {
    if (done) return;
    done = true; clearInterval(interval); clearTimeout(timer);
    try {
      try { fs.fsyncSync(output); } finally { fs.closeSync(output); }
      atomicJSON(stateFile, { ...state, status, exit_code: code, signal, error,
        finished_at: new Date().toISOString(), cleanup_pending_until: new Date(Date.now() + 600).toISOString(),
        output_bytes: outputBytes, total_output_bytes: totalBytes, output_truncated: totalBytes > outputBytes });
    } finally { cleanupGroup(); }
  };
  process.on('SIGTERM', () => finish('cancelled'));
  process.on('SIGINT', () => finish('cancelled'));
  process.on('uncaughtException', error => finish('failed', null, null, error.message));
  process.on('unhandledRejection', error => finish('failed', null, null, String(error)));
  const append = chunk => {
    if (done) return;
    totalBytes += chunk.length;
    const portion = chunk.subarray(0, Math.max(0, MAX_LOG - outputBytes));
    if (portion.length) { fs.writeSync(output, portion); outputBytes += portion.length; }
  };
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', state.command] : ['-c', state.command];
  try {
    child = spawn(shell, args, { cwd: state.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => finish('failed', null, null, error.message));
    child.on('close', (code, signal) => finish(code === 0 ? 'succeeded' : 'failed', code, signal));
    interval = setInterval(() => {
      try {
        if (fs.existsSync(path.join(directory, 'stop.json'))) { finish('cancelled'); return; }
        atomicJSON(path.join(directory, 'heartbeat.json'), { at: Date.now() });
      } catch (error) { finish('failed', null, null, error.message); }
    }, 200);
    timer = setTimeout(() => finish('timed_out'), state.timeout_ms);
  } catch (error) { finish('failed', null, null, error.message); }
}

export function createWorkspace(options = {}) {
  const defaultCwd = path.resolve(options.cwd || process.cwd());
  const sourceRoot = path.resolve(options.sourceRoot || SOURCE);
  const stateRoot = path.resolve(options.stateDir || path.join(os.homedir(), '.bytelight', 'workspace-jobs'));
  const configPath = options.configPath ?? path.join(sourceRoot, 'bytelight.yaml');
  const require = createRequire(pathToFileURL(path.join(sourceRoot, 'package.json')));
  let policyModule, policyCache;
  async function policy() {
    if (!configPath || !fs.existsSync(configPath)) return [];
    const stat = await fsp.stat(configPath), signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (policyCache?.signature === signature) return policyCache.patterns;
    const config = require('js-yaml').load(await fsp.readFile(configPath, 'utf8'));
    const patterns = config?.agent?.tool_deny_patterns ?? [];
    if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string')) throw new Error('Invalid operator tool_deny_patterns');
    const compiled = patterns.flatMap(p => { try { return [new RegExp(p)]; } catch { console.error('Ignoring invalid operator tool deny regex'); return []; } });
    policyCache = { signature, patterns: compiled };
    return compiled;
  }
  async function allowed(target, cwd) {
    const patterns = await policy();
    // Same relative-path matching as sensitive-paths.ts. Its builtin list is
    // intentionally empty; load it when deployed so future operator changes
    // to that shared implementation are also respected.
    const helper = path.join(sourceRoot, 'packages/backend/dist/services/tools/sensitive-paths.js');
    if (policyModule === undefined) policyModule = fs.existsSync(helper) ? await import(pathToFileURL(helper)) : null;
    if (policyModule?.isSensitivePath(target, cwd, patterns.map(p => p.source))) throw new Error('Operator policy denies this path');
    const relative = path.relative(cwd, target).split(path.sep).join('/') || '.';
    if (patterns.some(p => p.test(relative))) throw new Error('Operator policy denies this path');
  }
  async function cwdOf(value) {
    const cwd = await fsp.realpath(path.resolve(value ? text(value, 'cwd') : defaultCwd));
    if (!(await fsp.stat(cwd)).isDirectory()) throw new Error('cwd is not a directory');
    await allowed(cwd, cwd); return cwd;
  }
  async function targetOf(value, cwd, write = false, depth = 0) {
    if (depth > 32) throw new Error('Too many symbolic links');
    const logical = path.resolve(cwd, text(value, 'path'));
    await allowed(logical, cwd);
    let target;
    try { target = await fsp.realpath(logical); }
    catch (error) {
      if (!write || error.code !== 'ENOENT') throw error;
      const stat = await fsp.lstat(logical).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat?.isSymbolicLink()) return targetOf(path.resolve(path.dirname(logical), await fsp.readlink(logical)), cwd, true, depth + 1);
      target = path.join(await fsp.realpath(path.dirname(logical)), path.basename(logical));
    }
    await allowed(target, cwd); return target;
  }
  async function createParents(directory, cwd) {
    const missing = []; let parent = directory;
    while (!fs.existsSync(parent)) { missing.unshift(path.basename(parent)); const next = path.dirname(parent); if (next === parent) throw new Error('No existing parent directory'); parent = next; }
    parent = await fsp.realpath(parent); await allowed(parent, cwd);
    for (const name of missing) { parent = path.join(parent, name); await allowed(parent, cwd); await fsp.mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
  }
  async function fileState(target) {
    let handle;
    try {
      handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
      const stat = await handle.stat(), bytes = await smallBytes(handle, stat);
      return { stat, bytes, sha256: hash(bytes) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async function replace(target, bytes, expected, before) {
    if (bytes.length > MAX_EDIT) throw new Error('Write content exceeds byte limit');
    const initial = before === undefined ? await fileState(target) : before;
    if (expected !== undefined && expected !== (initial?.sha256 ?? 'missing')) throw new Error('Conflict: expected_sha256 does not match current file');
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temp, 'wx', initial ? initial.stat.mode & 0o7777 : 0o666);
      if (initial) {
        const own = await handle.stat();
        if (own.uid !== initial.stat.uid || own.gid !== initial.stat.gid) await handle.chown(initial.stat.uid, initial.stat.gid);
        await handle.chmod(initial.stat.mode & 0o7777);
      }
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      const current = await fileState(target);
      if ((current?.sha256 ?? 'missing') !== (initial?.sha256 ?? 'missing') || (current && initial && current.stat.ino !== initial.stat.ino)) throw new Error('Conflict: file changed during atomic write');
      await fsp.rename(temp, target);
      if (process.platform !== 'win32') { const directory = await fsp.open(path.dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      return { path: target, bytes: bytes.length, sha256: hash(bytes), created: !initial };
    } finally { await handle?.close(); await fsp.unlink(temp).catch(() => {}); }
  }
  function jobDir(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job_id');
    return path.join(stateRoot, id);
  }
  async function jobStatus(id, args = {}) {
    const directory = jobDir(id), state = json(path.join(directory, 'state.json'));
    let heartbeat = Date.parse(state.created_at);
    try { heartbeat = json(path.join(directory, 'heartbeat.json')).at; } catch {}
    if (!TERMINAL.has(state.status) && Date.now() - heartbeat > 15_000) {
      let alive = false;
      if (state.worker_pid) { try { process.kill(state.worker_pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; } }
      state.status = alive ? 'unresponsive' : 'interrupted'; state.error = 'Supervisor heartbeat lost. No automatic rerun or PID signalling attempted.';
    }
    const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = bounded(args.limit, PAGE, 64_000, 1);
    let output = '', size = 0;
    try {
      const file = await fsp.open(path.join(directory, 'output.log'), 'r');
      try { size = (await file.stat()).size; const bytes = Buffer.alloc(Math.min(limit, Math.max(0, size - offset))); const r = await file.read(bytes, 0, bytes.length, offset); output = bytes.subarray(0, r.bytesRead).toString('utf8'); }
      finally { await file.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { nonce, ...visible } = state;
    return { ...visible, command: state.command.slice(0, 2000), command_truncated: state.command.length > 2000,
      output, offset, next_offset: offset + Math.min(limit, Math.max(0, size - offset)) < size ? offset + limit : null,
      captured_output_bytes: size, output_limit_bytes: MAX_LOG,
      cleanup_pending: !!state.cleanup_pending_until && Date.now() < Date.parse(state.cleanup_pending_until) };
  }
  const tools = {
    async workspace_info() {
      return { hostname: os.hostname(), platform: process.platform, architecture: process.arch, cwd: await cwdOf(), home: os.homedir(),
        pid: process.pid, uid: process.getuid?.(), state_directory: stateRoot, host_scope: 'This host only. No Mac or other remote host is implied.',
        capabilities: ['list', 'read', 'search', 'write', 'edit', 'shell', 'durable_jobs', 'wait', 'stop'],
        restrictions: 'OS permissions and configured operator tool_deny_patterns; no added path jail or read-only mode.',
        command_shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', max_file_edit_bytes: MAX_EDIT, max_job_output_bytes: MAX_LOG,
        note: 'No git commits, pushes, deployments or paid runners happen automatically. Commands explicitly requested by the caller run with this process authority.' };
    },
    async workspace_list(args) {
      const cwd = await cwdOf(args.cwd), target = await targetOf(args.path || '.', cwd), offset = bounded(args.offset, 0, 100_000), limit = bounded(args.limit, 100, 500, 1);
      const directory = await fsp.opendir(target), entries = []; let index = 0, more = false;
      try {
        for await (const entry of directory) {
          if (index++ < offset) continue;
          if (entries.length >= limit) { more = true; break; }
          const full = path.join(target, entry.name);
          try { await allowed(full, cwd); const s = await fsp.lstat(full); entries.push({ name: entry.name, type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file', bytes: s.size, mode: (s.mode & 0o7777).toString(8) }); }
          catch (error) { entries.push({ name: entry.name, error: error.message }); }
        }
      } finally { await directory.close().catch(() => {}); }
      return { path: target, entries, offset, next_offset: more ? offset + entries.length : null, order: 'filesystem enumeration; directories may change between pages' };
    },
    async workspace_read(args) {
      const cwd = await cwdOf(args.cwd), target = await targetOf(args.path, cwd), offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = bounded(args.limit, PAGE, 64_000, 1);
      const file = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
      try {
        const stat = await file.stat(); if (!stat.isFile()) throw new Error('Target is not a regular file');
        const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset))), read = await file.read(buffer, 0, buffer.length, offset), bytes = buffer.subarray(0, read.bytesRead);
        return { path: target, content: bytes.toString(args.encoding === 'base64' ? 'base64' : 'utf8'), encoding: args.encoding === 'base64' ? 'base64' : 'utf8', offset,
          next_offset: offset + read.bytesRead < stat.size ? offset + read.bytesRead : null, bytes: stat.size,
          sha256: stat.size <= MAX_EDIT ? hash(await smallBytes(file, stat)) : null };
      } finally { await file.close(); }
    },
    async workspace_write(args) {
      const cwd = await cwdOf(args.cwd);
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      if (args.create_parents) { const parent = path.resolve(cwd, path.dirname(text(args.path, 'path'))); await allowed(parent, cwd); await createParents(parent, cwd); }
      const target = await targetOf(args.path, cwd, true);
      return replace(target, Buffer.from(args.content), args.expected_sha256);
    },
    async workspace_edit(args) {
      const cwd = await cwdOf(args.cwd), target = await targetOf(args.path, cwd), before = await fileState(target);
      const old = text(args.old_text, 'old_text', MAX_EDIT); if (typeof args.new_text !== 'string') throw new Error('new_text must be a string');
      const input = before.bytes.toString('utf8'), count = input.split(old).length - 1;
      if (!Buffer.from(input).equals(before.bytes)) throw new Error('Exact-text editing requires valid UTF8');
      if (count !== 1 && !args.replace_all) throw new Error(`Expected exactly one old_text match; found ${count}`);
      if (!count) throw new Error('old_text not found');
      return replace(target, Buffer.from(args.replace_all ? input.split(old).join(args.new_text) : input.replace(old, () => args.new_text)), args.expected_sha256, before);
    },
    async workspace_search(args) {
      const cwd = await cwdOf(args.cwd), root = await targetOf(args.path || '.', cwd), query = text(args.query, 'query', 4096), limit = bounded(args.limit, 30, 100, 1), offset = bounded(args.offset, 0, 10_000);
      const skip = args.skip_dirs ?? ['.git', 'node_modules']; if (!Array.isArray(skip) || skip.some(s => typeof s !== 'string')) throw new Error('Invalid skip_dirs');
      const matches = []; let files = 0, bytes = 0, count = 0, incomplete = false, more = false;
      const walk = async (target, depth) => {
        if (more || incomplete) return;
        if (depth > 20 || files >= 2000 || bytes >= 32 * 1024 * 1024) { incomplete = true; return; }
        try {
          await allowed(target, cwd); const stat = await fsp.lstat(target);
          if (stat.isSymbolicLink()) return;
          if (stat.isDirectory()) { const dir = await fsp.opendir(target); try { for await (const entry of dir) { if (!skip.includes(entry.name)) await walk(path.join(target, entry.name), depth + 1); if (more || incomplete) break; } } finally { await dir.close().catch(() => {}); } return; }
          if (!stat.isFile() || stat.size > 1024 * 1024) return;
          files++; const buffer = (await fileState(target))?.bytes; if (!buffer) return; bytes += buffer.length; if (buffer.includes(0)) return;
          const lines = buffer.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) if (lines[i].includes(query)) { if (count++ < offset) continue; if (matches.length >= limit) { more = true; break; } matches.push({ path: target, line: i + 1, text: lines[i].slice(0, 600) }); }
        } catch (error) { if (!/Operator policy/.test(error.message) && !['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; }
      };
      await walk(root, 0);
      return { matches, scanned_files: files, scanned_bytes: bytes, incomplete, next_offset: more ? offset + matches.length : null, symlinks_followed: false };
    },
    async workspace_run(args) {
      const cwd = await cwdOf(args.cwd), command = text(args.command, 'command', 64_000), timeout = bounded(args.timeout_ms, 120_000, 3_600_000, 100);
      const wait = bounded(args.wait_ms, 1000, 20_000);
      await policy();
      if (policyModule?.bashOrGlobTargetsSensitive(command)) throw new Error('Operator policy denies this command');
      await fsp.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      const stateStat = await fsp.stat(stateRoot);
      if ((stateStat.mode & 0o077) !== 0 || (process.getuid && stateStat.uid !== process.getuid())) throw new Error('Job state directory must be private (0700) and owned by this process user');
      const id = crypto.randomUUID(), directory = jobDir(id), nonce = crypto.randomUUID(); await fsp.mkdir(directory, { mode: 0o700 });
      atomicJSON(path.join(directory, 'state.json'), { job_id: id, status: 'queued', cwd, command, timeout_ms: timeout, nonce, created_at: new Date().toISOString() });
      const worker = spawn(process.execPath, [SELF, '--worker', directory, nonce], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
      worker.once('error', error => { const state = json(path.join(directory, 'state.json')); atomicJSON(path.join(directory, 'state.json'), { ...state, status: 'failed', error: error.message }); });
      worker.unref();
      const end = Date.now() + wait;
      let result;
      do { result = await jobStatus(id); if (TERMINAL.has(result.status) || Date.now() >= end) break; await delay(100); } while (true);
      return result;
    },
    async workspace_job(args) {
      if (!['status', 'wait', 'stop', 'list'].includes(args.action)) throw new Error('Invalid job action');
      const wait = bounded(args.wait_ms, args.action === 'stop' ? 2000 : 1000, 20_000);
      if (args.action === 'list') {
        const names = await fsp.readdir(stateRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const jobs = [], recent = [];
        for (const id of names.filter(n => /^[a-f0-9-]{36}$/.test(n))) { const stat = await fsp.stat(jobDir(id)); recent.push({ id, time: stat.birthtimeMs || stat.ctimeMs }); }
        recent.sort((a, b) => b.time - a.time);
        for (const { id } of recent.slice(0, bounded(args.limit, 50, 200, 1))) {
          const item = await jobStatus(id, { limit: 1 }); jobs.push({ job_id: id, status: item.status, cwd: item.cwd, created_at: item.created_at });
        }
        return { jobs };
      }
      const directory = jobDir(args.job_id);
      let result = await jobStatus(args.job_id, args);
      if (args.action === 'stop' && !TERMINAL.has(result.status)) { atomicJSON(path.join(directory, 'stop.json'), { requested_at: new Date().toISOString() }); }
      const end = Date.now() + (args.action === 'status' ? 0 : wait);
      while (!TERMINAL.has(result.status) && Date.now() < end) { await delay(100); result = await jobStatus(args.job_id, args); }
      return result;
    },
  };
  return { tools, call: async (name, args = {}) => { if (!tools[name]) throw new Error('Unknown workspace tool'); return tools[name](args); } };
}

const str = { type: 'string' }, integer = { type: 'integer' }, bool = { type: 'boolean' };
const common = { cwd: { ...str, description: 'Optional caller-chosen working directory on THIS host. Absolute paths outside the default cwd are allowed.' } };
const definitions = [
  ['workspace_info', 'Truthful host, cwd, permissions model and supported tools. Does not imply another computer is connected.', {}, []],
  ['workspace_list', 'Paged filesystem listing at caller-chosen path on this host.', { path: str, offset: integer, limit: integer }, []],
  ['workspace_read', 'Read a bounded byte page; returns whole-file SHA256 for files within edit limit. Byte offsets, not character offsets.', { path: str, offset: integer, limit: integer, encoding: { ...str, enum: ['utf8', 'base64'] } }, ['path']],
  ['workspace_search', 'Bounded literal recursive text search; default skips .git/node_modules, overridable with skip_dirs: [].', { path: str, query: str, offset: integer, limit: integer, skip_dirs: { type: 'array', items: str } }, ['query']],
  ['workspace_write', 'Atomic UTF8 write, follows symlinks without replacing the link, preserves existing target mode/ownership. Optional expected_sha256 (or missing) detects conflicts.', { path: str, content: str, expected_sha256: str, create_parents: bool }, ['path', 'content']],
  ['workspace_edit', 'Atomic exact-text edit. Require a unique match unless replace_all is explicit; optional expected_sha256 protects against stale reads.', { path: str, old_text: str, new_text: str, expected_sha256: str, replace_all: bool }, ['path', 'old_text', 'new_text']],
  ['workspace_run', 'Execute an explicitly requested shell/build command in caller-chosen cwd; stdin closed. Returns durable job ID. No implicit commit/push/deploy. timeout_ms 100..3600000, wait_ms 0..20000.', { command: str, timeout_ms: integer, wait_ms: integer }, ['command']],
  ['workspace_job', 'Recover/list/status/wait/stop durable jobs, with bounded paged combined stdout/stderr. Stop/timeout cleans process descendants; jobs survive MCP disconnect.', { action: { ...str, enum: ['status', 'wait', 'stop', 'list'] }, job_id: str, offset: integer, limit: integer, wait_ms: integer }, ['action']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties: { ...common, ...properties }, required, additionalProperties: false } }));

export async function serve(options) {
  const require = createRequire(pathToFileURL(path.join(options.sourceRoot || SOURCE, 'package.json')));
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const workspace = createWorkspace(options), server = new Server({ name: 'native-workspace', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try { const result = await workspace.call(request.params.name, request.params.arguments ?? {}); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code ?? 'workspace_error' }) }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === '--worker') runWorker(process.argv[3], process.argv[4]);
  else {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = { '--cwd': 'cwd', '--state-dir': 'stateDir', '--config': 'configPath', '--source-root': 'sourceRoot' }[process.argv[i]];
      if (!key || !process.argv[i + 1]) throw new Error('Usage: native-workspace-mcp.mjs [--cwd DIR] [--state-dir DIR] [--config YAML] [--source-root DIR]');
      options[key] = process.argv[i + 1];
    }
    await serve(options);
  }
}
