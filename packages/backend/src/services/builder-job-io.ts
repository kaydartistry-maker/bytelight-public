/** Small shared filesystem/process primitives; no app configuration or secrets imports. */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES = 16 * 1024;
export function redact(text: string): string {
  return text.replace(/-----BEGIN [^-]*(?:PRIVATE KEY)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/((?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?)[^\s,"';}]+/gi, '$1[REDACTED]')
    .replace(/(["']?[\w.-]*(?:token|password|passwd|secret|api[_-]?key|credential|cookie)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}
export function canonicalRoot(path: string, create = false): string {
  if (!path.startsWith('/') || resolve(path) !== path || path === '/') throw new Error('Canonical absolute builder path required');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error('Builder path must be a physical directory');
  return path;
}
export function privateDirectory(path: string): void {
  canonicalRoot(path, true);
  const st = statSync(path);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Builder state must be owned by worker identity and mode 0700');
}
export function appendEvent(path: string, type: string, message: string, max = MAX_LOG_BYTES): number {
  // One writer (the worker); request/stop never append to its log.
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Unsafe builder log');
    const event = Buffer.from(JSON.stringify({ at: new Date().toISOString(), type, message: redact(message).slice(0, 6000) }) + '\n');
    if (st.size + event.length > max) throw new Error('Builder log limit reached');
    appendFileSync(fd, event); return st.size + event.length;
  } finally { closeSync(fd); }
}
export function readEvents(path: string, cursor = 0, limit = 64 * 1024): { events: unknown[]; cursor: number } {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_LOG_BYTES) throw new Error('Invalid builder log cursor');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > MAX_LOG_BYTES || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Unsafe builder log');
    if (cursor > st.size) throw new Error('Cursor beyond log');
    if (cursor) { const prior = Buffer.alloc(1); readSync(fd, prior, 0, 1, cursor - 1); if (prior[0] !== 10) throw new Error('Cursor must follow event boundary'); }
    const bytes = Buffer.alloc(Math.min(limit, st.size - cursor)); readSync(fd, bytes, 0, bytes.length, cursor);
    const end = bytes.lastIndexOf(10); if (end < 0) return { events: [], cursor };
    return { events: bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)), cursor: cursor + end + 1 };
  } finally { closeSync(fd); }
}
export interface ProcessIdentity { pid: number; starttime: string; pgid: number; commandHash: string; }
export function processIdentity(pid: number, procRoot = '/proc'): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    const command = readFileSync(`${procRoot}/${pid}/cmdline`);
    return { pid, starttime: fields[19], pgid: Number(fields[2]), commandHash: createHash('sha256').update(command).digest('hex') };
  } catch { return null; }
}
export function matchesProcess(expected: ProcessIdentity, inspect = processIdentity): boolean {
  const actual = inspect(expected.pid);
  return !!actual && actual.starttime === expected.starttime && actual.pgid === expected.pgid && actual.commandHash === expected.commandHash;
}
export function signalGroup(expected: ProcessIdentity, signal: NodeJS.Signals, inspect = processIdentity, kill = process.kill): boolean {
  if (expected.pgid !== expected.pid || !matchesProcess(expected, inspect)) return false;
  kill(-expected.pgid, signal); return true;
}
export function assertJobId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid builder job id');
}

/** Stateful line redaction: secrets split across pipe chunks or PEM lines never reach disk. */
export class BuilderOutput {
  private tail = '';
  private dropping = false;
  private privateKey = false;
  constructor(private emit: (line: string) => void) {}
  write(text: string, final = false): void {
    this.tail += text;
    let end: number;
    while ((end = this.tail.indexOf('\n')) >= 0) {
      let line = this.tail.slice(0, end); this.tail = this.tail.slice(end + 1);
      if (this.dropping) { this.dropping = false; continue; }
      if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) this.privateKey = true;
      if (this.privateKey) { const done = /-----END .*PRIVATE KEY-----/.test(line); line = '[REDACTED PRIVATE KEY]'; if (done) this.privateKey = false; }
      this.emit(line.length > 12000 ? '[oversize output line omitted]' : redact(line));
    }
    if (this.tail.length > 24000) { this.tail = ''; this.dropping = true; this.emit('[oversize unterminated output omitted]'); }
    if (final && this.tail && !this.dropping) {
      this.emit(this.privateKey ? '[REDACTED PRIVATE KEY]' : redact(this.tail)); this.tail = '';
    }
  }
}

export function specialistSandbox(request: { cwd: string; home: string; commonGit: string; args: string[] }): string[] {
  // Network stays shared. Only job files, Git administration and the coding HOME
  // are writable. A PID namespace makes daemonized/setsid descendants stoppable.
  return ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent',
    '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/root',
    // Preserve DNS when /etc/resolv.conf points into the hidden /run tree.
    '--ro-bind', '/etc/resolv.conf', realpathSync('/etc/resolv.conf'),
    '--bind', request.cwd, request.cwd, '--bind', request.home, request.home,
    '--bind', request.commonGit, request.commonGit,
    '--proc', '/proc', '--dev', '/dev', '--chdir', request.cwd,
    '--', '/usr/bin/codex', ...request.args];
}
