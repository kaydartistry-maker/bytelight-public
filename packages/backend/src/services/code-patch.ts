/** Canonical working-tree snapshot. A temporary index never changes the real index. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, lstatSync, realpathSync, statSync, chownSync, mkdirSync, chmodSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, existsSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function safeEnv(home = '/nonexistent'): NodeJS.ProcessEnv {
  return { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', USER: 'builder', LOGNAME: 'builder', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' };
}
export function identity(prefix: string) {
  const raw = [process.env[`${prefix}_UID`], process.env[`${prefix}_GID`]];
  const [uid, gid] = raw.map(Number);
  if (!raw.every(v => typeof v === 'string' && /^[1-9][0-9]*$/.test(v)) || ![uid, gid].every(n => Number.isSafeInteger(n) && n > 0 && n < 4294967295)) throw new Error(`${prefix} requires nonzero UID/GID`);
  return { uid, gid };
}
/** setuid alone retains the root service's supplementary groups. Drop those too. */
export function execution(file: string, args: string[], id?: { uid: number; gid: number }) {
  if (!id || id.uid === 0) return { file, args };
  if (process.getuid?.() === 0) return {
    file: '/usr/bin/setpriv',
    args: [`--reuid=${id.uid}`, `--regid=${id.gid}`, '--clear-groups', '--no-new-privs', '--', file, ...args],
  };
  if (process.getuid?.() !== id.uid || process.getgid?.() !== id.gid || (!process.getgroups || process.getgroups().some(g => g !== id.gid))) throw new Error('Unsafe process identity or supplementary groups');
  return { file, args };
}
export function gitBytes(cwd: string, args: string[], env = safeEnv()): Buffer {
  const owner = statSync(cwd);
  const cmd = execution('/usr/bin/git', ['-c', `safe.directory=${cwd}`, ...args], owner);
  return execFileSync(cmd.file, cmd.args, { cwd, env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}
export function privatePath(path: string): boolean {
  return path.split('/').some(p => /^(?:\.git|\.env.*|\.ssh|\.aws|\.codex|\.npmrc|\.netrc|\.git-credentials|data|memory-vault|credentials.*|bytelight\.yaml)$/i.test(p)) || /(?:secret|credential|auth\.json|\.pem$|\.key$)/i.test(path);
}
export function pendingPatch(cwd: string, mode?: { production: true; expectedFiles: string[] }) {
  cwd = realpathSync(cwd);
  const dir = mkdtempSync(join(tmpdir(), 'bl-index-'));
  const owner = statSync(cwd);
  chmodSync(dir, 0o755);
  const writable = join(dir, 'writable');
  mkdirSync(writable, { mode: 0o700 });
  if (owner.uid !== process.getuid?.() || owner.gid !== process.getgid?.()) chownSync(writable, owner.uid, owner.gid);
  try {
    const env = { ...safeEnv(), GIT_LITERAL_PATHSPECS: '1', GIT_INDEX_FILE: join(writable, 'index') };
    const headEntries = gitBytes(cwd, ['ls-tree', '-rz', '--full-tree', 'HEAD']).toString().split('\0').filter(Boolean);
    for (const entry of headEntries) {
      if (/^(120000|160000) /.test(entry)) throw new Error('Unsafe tracked archive entry');
    }
    gitBytes(cwd, ['read-tree', 'HEAD'], env);
    const allNames = gitBytes(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean);
    const committed = new Set(headEntries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
    const changed = gitBytes(cwd, ['diff', '--name-only', '-z', 'HEAD', '--']).toString().split('\0').filter(Boolean);
    const expected = mode?.expectedFiles;
    if (expected?.some(name => !name || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || privatePath(name))) throw new Error('Unsafe expected path');
    if (expected && changed.some(name => !expected.includes(name))) throw new Error('Unexpected tracked production change');
    const names = expected ?? allNames;
    for (const name of expected ?? [...changed, ...names.filter(name => !committed.has(name))]) {
      if (privatePath(name)) throw new Error(`Blocked path: ${name}`);
    }
    for (const name of names) {
      let cursor = cwd;
      for (const part of name.split('/')) {
        cursor = resolve(cursor, part);
        try { const s = lstatSync(cursor); if (cursor === resolve(cwd, name) && !s.isFile()) throw new Error(`Symlink or special expected file: ${name}`); if (!s.isFile() && !s.isDirectory()) throw new Error(`Symlink or special file: ${name}`); if (s.isFile() && s.nlink !== 1) throw new Error(`Hardlink: ${name}`); if (s.isSymbolicLink()) throw new Error(`Symlink: ${name}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
    if (gitBytes(cwd, ['ls-files', '--stage']).toString().split('\n').some(l => l.startsWith('160000 '))) throw new Error('Submodules are forbidden');
    if (!expected) gitBytes(cwd, ['add', '-A', '--', '.'], env);
    else for (const name of expected) {
      if (existsSync(join(cwd, name))) gitBytes(cwd, ['add', '-f', '--', name], env);
      else if (committed.has(name)) gitBytes(cwd, ['update-index', '--force-remove', '--', name], env);
    }
    // Preserve files already tracked in the real index even if a new ignore rule now hides them.
    const present = names.filter(name => existsSync(join(cwd, name)));
    for (let i = 0; i < present.length; i += 100) gitBytes(cwd, ['add', '-f', '--', ...present.slice(i, i + 100)], env);
    const tree = gitBytes(cwd, ['write-tree'], env).toString().trim();
    // Freeze the temporary index before validation/diff: Codex cannot race its entries.
    const fd = openSync(env.GIT_INDEX_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 32 * 1024 * 1024) throw new Error('Unsafe temporary index');
      const sealedIndex = join(dir, 'sealed-index');
      writeFileSync(sealedIndex, readFileSync(fd), { mode: 0o444, flag: 'wx' });
      env.GIT_INDEX_FILE = sealedIndex;
    } finally { closeSync(fd); }

    for (const entry of gitBytes(cwd, ['ls-files', '--stage', '-z'], env).toString().split('\0').filter(Boolean)) {
      if (/^(120000|160000) /.test(entry)) throw new Error('Unsafe pending entry');
    }
    if (gitBytes(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', tree], env).length) throw new Error('Snapshot tree changed before sealing');
    const patch = gitBytes(cwd, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'], env);
    const files = gitBytes(cwd, ['diff', '--cached', '--name-only', '-z', 'HEAD'], env).toString().split('\0').filter(Boolean);
    for (const name of files) if (privatePath(name)) throw new Error(`Blocked path: ${name}`);
    return { tree, patch, files, diff_sha256: createHash('sha256').update(patch).digest('hex') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
