/** Local-only exact checkpoint transaction. Never modifies worktree bytes. */
import { readFileSync, writeFileSync, rmSync, openSync, closeSync, fstatSync, ftruncateSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pendingPatch, gitBytes, safeEnv } from './code-patch.js';
export interface CheckpointBoundary {
  git: typeof gitBytes; snapshot: typeof pendingPatch;
  readIndex(path: string): Buffer | undefined; restoreIndex(path: string, bytes: Buffer | undefined): void;
}
function indexAccess(path: string, write?: Buffer): Buffer | undefined {
  const parent = openSync(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const anchored = `/proc/self/fd/${parent}/index`;
    let fd: number;
    try { fd = openSync(anchored, (write ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if (!write && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 32 * 1024 * 1024) throw new Error('Unsafe checkpoint index');
      if (write) { writeFileSync(fd, write); /* truncate only after validating the open inode */ ftruncateSync(fd, write.length); return; }
      return readFileSync(fd);
    } finally { closeSync(fd); }
  } finally { closeSync(parent); }
}
const boundary: CheckpointBoundary = {
  git: gitBytes, snapshot: pendingPatch,
  readIndex: path => indexAccess(path),
  restoreIndex(path, bytes) { if (bytes) indexAccess(path, bytes); else { const fd = openSync(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { rmSync(`/proc/self/fd/${fd}/index`, { force: true }); } finally { closeSync(fd); } } },
};
export function finalizeCheckpoint(dev: string, prod: string, req: { branch: string; head: string; diff_sha256: string; files: string[] }, patch: Buffer, io: CheckpointBoundary = boundary) {
  const gitBytes = io.git, pendingPatch = io.snapshot;
  if (!/^codex\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(req.branch)) throw new Error('Checkpoint requires codex branch');
  const repos = [dev, prod];
  const snapshots = repos.map((p, i) => pendingPatch(p, i ? { production: true, expectedFiles: req.files } : undefined));
  if (gitBytes(dev, ['branch', '--show-current']).toString().trim() !== req.branch) throw new Error('Checkpoint branch changed');
  for (const [i, snap] of snapshots.entries()) {
    if (snap.diff_sha256 !== req.diff_sha256 || !snap.patch.equals(patch) || JSON.stringify(snap.files) !== JSON.stringify(req.files) || gitBytes(repos[i], ['rev-parse', 'HEAD']).toString().trim() !== req.head) throw new Error('Checkpoint snapshot/base/files changed');
  }
  if (!snapshots[0].tree || snapshots[0].tree !== snapshots[1].tree) throw new Error('Checkpoint trees differ');
  const refs = repos.map(p => gitBytes(p, ['symbolic-ref', 'HEAD']).toString().trim());
  if (refs[0] !== `refs/heads/${req.branch}`) throw new Error('Checkpoint development ref changed');
  if (refs[1] !== 'refs/heads/main') throw new Error('Checkpoint production HEAD must be main');
  if (gitBytes(dev, ['rev-parse', 'refs/heads/main']).toString().trim() !== req.head) throw new Error('Checkpoint development main base changed');
  if (refs.some(ref => !/^refs\/heads\/[a-zA-Z0-9/_-]+$/.test(ref))) throw new Error('Checkpoint requires local branches');
  const indexes = repos.map(p => {
    const path = gitBytes(p, ['rev-parse', '--absolute-git-dir']).toString().trim();
    // Only ordinary repositories, no linked worktrees or external Git directories.
    if (path !== join(p, '.git')) throw new Error('Checkpoint Git directory mismatch');
    const index = join(path, 'index'); return io.readIndex(index);
  });
  const env = { ...safeEnv(), GIT_AUTHOR_NAME: 'Virelle System', GIT_AUTHOR_EMAIL: 'system@virelle.invalid', GIT_COMMITTER_NAME: 'Virelle System', GIT_COMMITTER_EMAIL: 'system@virelle.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const commits = repos.map((p, i) => gitBytes(p, ['commit-tree', snapshots[i].tree, '-p', req.head, '-m', `Verified local checkpoint ${req.diff_sha256}`], env).toString().trim());
  if (commits[0] !== commits[1]) throw new Error('Checkpoint commit objects differ');
  const targets = [{ repo: dev, ref: refs[0] }, { repo: dev, ref: 'refs/heads/main' }, { repo: prod, ref: refs[1] }];
  const moved: typeof targets = [];
  try {
    // Validate all bases and worktrees before the first mutation.
    for (const { repo, ref } of targets) {
      if (gitBytes(repo, ['rev-parse', ref]).toString().trim() !== req.head) throw new Error('Checkpoint ref base changed');
    }
    for (const [i, p] of repos.entries()) {
      const recheck = pendingPatch(p, i ? { production: true, expectedFiles: req.files } : undefined);
      if (recheck.tree !== snapshots[0].tree || !recheck.patch.equals(patch) || JSON.stringify(recheck.files) !== JSON.stringify(req.files) || recheck.diff_sha256 !== req.diff_sha256 || gitBytes(p, ['symbolic-ref', 'HEAD']).toString().trim() !== refs[i]) throw new Error('Checkpoint changed during finalization');
    }
    for (const target of targets) {
      gitBytes(target.repo, ['update-ref', target.ref, commits[0], req.head]); moved.push(target);
    }
    for (const p of repos) gitBytes(p, ['read-tree', commits[0]]);
    for (const { repo, ref } of targets) {
      if (gitBytes(repo, ['rev-parse', ref]).toString().trim() !== commits[0]) throw new Error('Checkpoint ref verification failed');
    }
    for (const [i, p] of repos.entries()) {
      if (gitBytes(p, ['symbolic-ref', 'HEAD']).toString().trim() !== refs[i] || gitBytes(p, ['rev-parse', 'HEAD']).toString().trim() !== commits[0] || gitBytes(p, ['rev-parse', 'HEAD^{tree}']).toString().trim() !== snapshots[0].tree || pendingPatch(p, i ? { production: true, expectedFiles: req.files } : undefined).files.length) throw new Error('Checkpoint verification failed');
    }
    return { checkpoint_id: commits[0], development_main_head: commits[0], tree: snapshots[0].tree, development_clean: true, production_clean: true, synchronized: true };
  } catch (error) {
    const failures: string[] = [];
    for (const target of moved.reverse()) {
      try { gitBytes(target.repo, ['update-ref', target.ref, req.head, commits[0]]); }
      catch (restore) { failures.push(String(restore)); }
    }
    for (const [i, p] of repos.entries()) {
      try { io.restoreIndex(join(p, '.git/index'), indexes[i]); }
      catch (restore) { failures.push(String(restore)); }
    }
    if (failures.length) throw new Error(`Recovery Required: checkpoint restoration failed: ${failures.join('; ')}; ${String(error)}`);
    throw error;
  }
}
