/** Trusted coordinator only. Never imports workspace node_modules or shares writable inodes. */
import { createHash, randomBytes } from 'node:crypto';
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { privateDirectory } from './builder-job-io.js';

export const dependencyPolicy = 'npm-ci-ignore-scripts;reviewed-native-rebuild;cache-v1';
export function dependencyKey(inputs: [string, string][], native: string[], runtime = {
  node: process.version, platform: process.platform, arch: process.arch,
  abi: process.versions.modules, versions: process.versions,
}): string {
  return createHash('sha256').update(JSON.stringify({ policy: dependencyPolicy, runtime, native: [...native].sort(), inputs: [...inputs].sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}
function realDirectory(path: string): void {
  const absolute = resolve(path);
  if (dirname(absolute) !== absolute) realDirectory(dirname(absolute));
  const st = lstatSync(absolute);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Unsafe dependency directory/ancestor');
}
/** Only roots captured by trusted publication, with every root checked before deletion. */
export function removePublishedDependencies(stage: string, paths: string[]): void {
  realDirectory(stage);
  for (const path of paths) {
    const parts = path.split('/');
    if (isAbsolute(path) || parts.some(p => !p || p === '.' || p === '..') || parts.at(-1) !== 'node_modules') throw Error('Unsafe dependency removal path');
    realDirectory(join(stage, path));
  }
  for (const path of paths) rmSync(join(stage, path), { recursive: true });
}
export function dependencyPaths(stage: string): string[] {
  realDirectory(stage);
  const paths: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), st = lstatSync(path);
      if (name === 'node_modules') { if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Unsafe dependency root'); paths.push(relative(stage, path)); }
      else if (st.isDirectory() && !name.startsWith('.')) walk(path);
    }
  }
  walk(stage); return paths;
}
function inventory(root: string): { digest: string; bytes: number } {
  const digest = createHash('sha256'); let bytes = 0;
  const links = new Map<string, string>();
  const field = (value: string | Buffer) => { digest.update(String(Buffer.byteLength(value)) + ':'); digest.update(value); };
  function visit(path: string) {
    const st = lstatSync(path);
    if (st.uid !== process.getuid!() || st.gid !== process.getgid!() || ( !st.isSymbolicLink() && st.mode & 0o022)) throw Error(`Unsafe dependency artifact ownership/mode: path=${JSON.stringify(relative(root, path) || '.')} actual uid=${st.uid} gid=${st.gid} mode=0${(st.mode & 0o7777).toString(8)} expected uid=${process.getuid!()} gid=${process.getgid!()} mode=${st.isSymbolicLink() ? 'symlink (mode ignored)' : 'no group/other write bits (mask 0022)'}`);
    field(relative(root, path)); field(String(st.mode & 0o777));
    if (st.isSymbolicLink()) {
      // npm workspace/bin links are allowed only inside the virtual release root.
      const link = readlinkSync(path), target = resolve(dirname(path), link);
      if (isAbsolute(link) || !target.startsWith(root + '/')) throw Error('Escaping dependency symlink');
      links.set(relative(root, path), link); field('link'); field(link);
    } else if (st.isDirectory()) { field('directory'); for (const name of readdirSync(path).sort()) visit(join(path, name)); }
    else if (st.isFile() && st.nlink === 1) { field('file'); const data = readFileSync(path); field(data); bytes += data.length; }
    else throw Error('Unsafe dependency artifact type/link count');
  }
  visit(root);
  // Resolve components before '..': lexical normalization alone can hide an
  // escape through a second symlink. Missing workspace source targets are OK.
  for (const [path, link] of links) {
    const parts = [...relative(root, dirname(join(root, path))).split('/').filter(Boolean), ...link.split('/')];
    const resolved: string[] = []; let hops = 0;
    while (parts.length) {
      const part = parts.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') { if (!resolved.length) throw Error('Escaping dependency symlink chain'); resolved.pop(); continue; }
      const target = links.get([...resolved, part].join('/'));
      if (target !== undefined) { if (++hops > 40) throw Error('Cyclic dependency symlink'); parts.unshift(...target.split('/')); }
      else resolved.push(part);
    }
  }
  return { digest: digest.digest('hex'), bytes };
}
type Copy = (source: string, target: string, root?: string, purpose?: 'dependency-cache-publication') => void;
export class DependencyCache {
  constructor(private root: string, private copy: Copy) { privateDirectory(root); }
  private entry(key: string): string { if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid dependency key'); return join(this.root, key); }
  restore(key: string, stage: string, owner: { uid: number; gid: number }, chown: (path: string, uid: number, gid: number) => void = chownSync): { bytes: number } | undefined {
    const entry = this.entry(key);
    const destination = lstatSync(stage);
    if (!destination.isDirectory() || destination.isSymbolicLink()) throw Error('Unsafe dependency destination');
    try { lstatSync(entry); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    privateDirectory(entry);
    const metadata = join(entry, 'manifest.json'), st = lstatSync(metadata);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid!() || st.gid !== process.getgid!() || st.mode & 0o077) throw Error('Unsafe dependency manifest');
    const manifest = JSON.parse(readFileSync(metadata, 'utf8'));
    const tree = join(entry, 'tree'), actual = inventory(tree);
    if (manifest.key !== key || manifest.digest !== actual.digest || manifest.bytes !== actual.bytes) throw Error('Dependency artifact digest mismatch');
    const paths = dependencyPaths(tree);
    // Do not accept caller-controlled metadata paths or overlay an existing install.
    for (const path of paths) {
      let cursor = stage;
      for (const part of path.split('/').slice(0, -1)) { cursor = join(cursor, part); const s = lstatSync(cursor); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Unsafe dependency destination'); }
      try { lstatSync(join(stage, path)); throw Error('Dependency destination exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const path of paths) this.copy(join(tree, path), join(stage, path), tree);
    function own(path: string) { const s = lstatSync(path); if (s.isSymbolicLink()) return; chown(path, owner.uid, owner.gid); if (s.isDirectory()) for (const name of readdirSync(path)) own(join(path, name)); }
    for (const path of paths) own(join(stage, path));
    return { bytes: actual.bytes };
  }
  /** Called only under the coordinator deployment lock after dependency verification/publication. */
  retain(key: string): void {
    const entries = readdirSync(this.root).filter(name => /^[a-f0-9]{64}$/.test(name));
    for (const name of entries) privateDirectory(this.entry(name));
    const old = entries.filter(name => name !== key).sort((a, b) => lstatSync(this.entry(b)).mtimeMs - lstatSync(this.entry(a)).mtimeMs);
    for (const name of old.slice(1)) rmSync(this.entry(name), { recursive: true });
  }
  publish(key: string, stage: string): { bytes: number; paths: string[] } {
    const entry = this.entry(key), pending = join(this.root, '.pending-' + randomBytes(16).toString('hex'));
    mkdirSync(pending, { mode: 0o700 });
    try {
      const tree = join(pending, 'tree'); mkdirSync(tree, { mode: 0o755 });
      // Only trusted post-install, pre-application-build publication accepts source
      // aliases (node-gyp Make copies use hardlinks). copyFile creates independent
      // inodes; inventory below still rejects every hardlinked cache artifact.
      const paths = dependencyPaths(stage);
      for (const path of paths) this.copy(join(stage, path), join(tree, path), stage, 'dependency-cache-publication');
      // Copies are owned by trusted coordinator; normalize directory modes before hashing.
      chmodSync(tree, 0o755);
      const actual = inventory(tree);
      writeFileSync(join(pending, 'manifest.json'), JSON.stringify({ key, ...actual }), { flag: 'wx', mode: 0o600 });
      try { renameSync(pending, entry); } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        // Another publisher won. Its artifact is verified on use; never overwrite it.
      }
      return { bytes: actual.bytes, paths };
    } finally { rmSync(pending, { recursive: true, force: true }); }
  }
}
