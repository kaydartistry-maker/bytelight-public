import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitBytes, pendingPatch, safeEnv } from './code-patch.js';
import { finalizeCheckpoint } from './code-checkpoint.js';
test('exact same deterministic local checkpoint and clean trees; extra changes and ref failure refuse', (t) => {
  try { execFileSync('/usr/bin/git', ['--version'], { env: safeEnv() }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Sandbox denies Node subprocesses; injectable transaction tests still run'); throw e; }
  for (const failure of ['none', 'dev', 'unsafe', 'symlink', 'hardlink', 'tracked', 'base', 'dev-ref', 'dev-main-ref', 'prod-ref', 'prod-branch', 'dev-main-base']) {
    const root = mkdtempSync(join(tmpdir(), 'bl-checkpoint-'));
    const dev = join(root, 'dev'), prod = join(root, 'prod'); mkdirSync(dev); mkdirSync(prod);
    const env = { ...safeEnv(), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
    try {
      for (const p of [dev, prod]) { gitBytes(p, ['init', '-b', 'main']); writeFileSync(join(p, '.gitignore'), 'runtime/\n'); writeFileSync(join(p, 'deleted'), 'old'); writeFileSync(join(p, 'file'), 'before'); gitBytes(p, ['add', '.']); gitBytes(p, ['commit', '-m', 'base'], env); writeFileSync(join(p, 'file'), 'after'); unlinkSync(join(p, 'deleted')); writeFileSync(join(p, 'new'), 'new bytes'); }
      gitBytes(dev, ['checkout', '-b', 'codex/test']);
      mkdirSync(join(prod, 'runtime')); writeFileSync(join(prod, 'runtime', 'active'), 'ignored runtime');
      mkdirSync(join(prod, 'memory-vault/.letta'), { recursive: true }); writeFileSync(join(prod, 'memory-vault/.letta/config.json'), 'synthetic runtime fixture');
      const snap = pendingPatch(dev), head = gitBytes(dev, ['rev-parse', 'HEAD']).toString().trim();
      const req = { branch: 'codex/test', head, diff_sha256: snap.diff_sha256, files: snap.files };
      if (failure === 'symlink' || failure === 'hardlink') { unlinkSync(join(prod, 'new')); if (failure === 'symlink') symlinkSync(join(prod, 'file'), join(prod, 'new')); else linkSync(join(prod, 'file'), join(prod, 'new')); }
      if (failure === 'unsafe') req.files = ['memory-vault/.letta/config.json'];
      if (failure === 'dev' || failure === 'prod') writeFileSync(join(failure === 'dev' ? dev : prod, 'extra'), 'unapproved');
      if (failure === 'base') req.head = 'a'.repeat(40);
      if (failure === 'tracked') writeFileSync(join(prod, '.gitignore'), 'changed');
      if (failure === 'prod-branch') gitBytes(prod, ['checkout', '-b', 'other']);
      if (failure === 'dev-main-base') gitBytes(dev, ['update-ref', 'refs/heads/main', gitBytes(dev, ['commit-tree', snap.tree, '-p', head, '-m', 'other'], env).toString().trim(), head]);
      if (failure.endsWith('-ref')) {
        const p = failure === 'prod-ref' ? prod : dev;
        const ref = failure === 'dev-ref' ? 'codex/test' : 'main';
        writeFileSync(join(p, `.git/refs/heads/${ref}.lock`), 'locked');
      }
      const mainBefore = gitBytes(dev, ['rev-parse', 'refs/heads/main']).toString().trim();
      const indexes = [dev, prod].map(p => readFileSync(join(p, '.git/index')));
      if (failure === 'none') {
        const result = finalizeCheckpoint(dev, prod, req, snap.patch);
        assert.equal(result.synchronized, true);
        assert.equal(result.development_main_head, result.checkpoint_id);
        assert.equal(gitBytes(dev, ['rev-parse', 'refs/heads/main']).toString().trim(), result.checkpoint_id);
        for (const p of [dev, prod]) { assert.equal(gitBytes(p, ['rev-parse', 'HEAD']).toString().trim(), result.checkpoint_id); assert.equal(pendingPatch(p, p === prod ? { production: true, expectedFiles: req.files } : undefined).files.length, 0); }
      } else {
        assert.throws(() => finalizeCheckpoint(dev, prod, req, snap.patch));
        assert.equal(gitBytes(dev, ['rev-parse', 'refs/heads/main']).toString().trim(), mainBefore);
        for (const [i, p] of [dev, prod].entries()) { assert.equal(gitBytes(p, ['rev-parse', 'HEAD']).toString().trim(), head); assert.deepEqual(readFileSync(join(p, '.git/index')), indexes[i]); }
      }
      for (const p of [dev, prod]) assert.equal(readFileSync(join(p, 'file'), 'utf8'), 'after');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});


test('transaction CAS covers all three refs and restores both indexes after each mutation failure', () => {
  for (const failure of [0, 1, 2, 3, 4]) {
    const refs = new Map([['/dev:refs/heads/codex/test', 'base'], ['/dev:refs/heads/main', 'base'], ['/prod:refs/heads/main', 'base']]);
    const restored: string[] = [], mutations: string[] = [];
    const snap = { tree: 'tree', patch: Buffer.from('patch'), files: ['file'], diff_sha256: 'fingerprint' };
    let updates = 0;
    const headRef = (p: string) => p === '/dev' ? 'refs/heads/codex/test' : 'refs/heads/main';
    const io = {
      snapshot(p: string) { return refs.get(`${p}:${headRef(p)}`) === 'commit' ? { ...snap, files: [], patch: Buffer.alloc(0) } : snap; },
      git(p: string, args: string[]) {
        if (args[0] === 'branch') return Buffer.from('codex/test');
        if (args[0] === 'symbolic-ref') return Buffer.from(headRef(p));
        if (args[0] === 'rev-parse') return Buffer.from(args[1] === '--absolute-git-dir' ? p + '/.git' : args[1] === 'HEAD^{tree}' ? 'tree' : refs.get(`${p}:${args[1] === 'HEAD' ? headRef(p) : args[1]}`)!);
        if (args[0] === 'commit-tree') return Buffer.from('commit');
        if (args[0] === 'update-ref') {
          if (args[2] === 'commit' && ++updates === failure) throw new Error('injected ref failure');
          const key = `${p}:${args[1]}`;
          assert.equal(refs.get(key), args[3]); refs.set(key, args[2]); mutations.push(key);
        }
        if (args[0] === 'read-tree' && failure === 4) throw new Error('injected index failure');
        return Buffer.alloc(0);
      },
      readIndex() { return Buffer.from('original'); },
      restoreIndex(p: string, bytes: Buffer | undefined) { assert.equal(bytes?.toString(), 'original'); restored.push(p); },
    };
    const req = { branch: 'codex/test', head: 'base', files: ['file'], diff_sha256: 'fingerprint' };
    if (!failure) {
      const result = finalizeCheckpoint('/dev', '/prod', req, snap.patch, io);
      assert.equal(result.development_main_head, 'commit');
      assert.deepEqual([...refs.values()], ['commit', 'commit', 'commit']);
      assert.deepEqual(mutations, [...refs.keys()]);
    } else {
      assert.throws(() => finalizeCheckpoint('/dev', '/prod', req, snap.patch, io), /injected/);
      assert.deepEqual([...refs.values()], ['base', 'base', 'base']);
      assert.deepEqual(restored, ['/dev/.git/index', '/prod/.git/index']);
      assert.equal(mutations.length, 2 * Math.min(failure - 1, 3));
    }
  }
});

test('ref recovery failure still attempts every other ref and both indexes', () => {
  const refs = new Map([['/dev:refs/heads/codex/test', 'base'], ['/dev:refs/heads/main', 'base'], ['/prod:refs/heads/main', 'base']]);
  const restored: string[] = [];
  const snap = { tree: 'tree', patch: Buffer.from('patch'), files: ['file'], diff_sha256: 'fingerprint' };
  const refFor = (p: string) => p === '/dev' ? 'refs/heads/codex/test' : 'refs/heads/main';
  const io = {
    snapshot() { return snap; },
    git(p: string, args: string[]) {
      if (args[0] === 'branch') return Buffer.from('codex/test');
      if (args[0] === 'symbolic-ref') return Buffer.from(refFor(p));
      if (args[0] === 'rev-parse') return Buffer.from(args[1] === '--absolute-git-dir' ? p + '/.git' : refs.get(`${p}:${args[1] === 'HEAD' ? refFor(p) : args[1]}`)!);
      if (args[0] === 'commit-tree') return Buffer.from('commit');
      if (args[0] === 'update-ref') {
        if (p === '/prod' || args[1] === 'refs/heads/main' && args[2] === 'base') throw new Error('injected ref failure');
        const key = `${p}:${args[1]}`; assert.equal(refs.get(key), args[3]); refs.set(key, args[2]);
      }
      return Buffer.alloc(0);
    },
    readIndex() { return Buffer.from('index'); },
    restoreIndex(p: string) { restored.push(p); },
  };
  assert.throws(() => finalizeCheckpoint('/dev', '/prod', { branch: 'codex/test', head: 'base', files: snap.files, diff_sha256: snap.diff_sha256 }, snap.patch, io), /Recovery Required/);
  assert.equal(refs.get('/dev:refs/heads/codex/test'), 'base');
  assert.deepEqual(restored, ['/dev/.git/index', '/prod/.git/index']);
});

test('unequal trees, extra changes and a wrong main base fail before any ref mutation', () => {
  for (const failure of ['tree', 'files', 'patch', 'main-base', 'prod-head']) {
    const snap = { tree: 'tree', patch: Buffer.from('patch'), files: ['file'], diff_sha256: 'fingerprint' };
    const io = {
      snapshot(p: string) { return p === '/prod' ? { ...snap, tree: failure === 'tree' ? 'other' : 'tree', files: failure === 'files' ? ['file', 'extra'] : ['file'], patch: failure === 'patch' ? Buffer.from('other') : snap.patch } : snap; },
      git(p: string, args: string[]) {
        assert.notEqual(args[0], 'update-ref');
        if (args[0] === 'branch') return Buffer.from('codex/test');
        if (args[0] === 'symbolic-ref') return Buffer.from(p === '/dev' || failure === 'prod-head' ? 'refs/heads/codex/test' : 'refs/heads/main');
        if (args[0] === 'rev-parse') return Buffer.from(args[1] === 'refs/heads/main' && failure === 'main-base' ? 'other' : 'base');
        assert.fail('unexpected checkpoint write');
      },
      readIndex() { assert.fail('unexpected index read'); },
      restoreIndex() { assert.fail('unexpected index restoration'); },
    };
    assert.throws(() => finalizeCheckpoint('/dev', '/prod', { branch: 'codex/test', head: 'base', files: snap.files, diff_sha256: snap.diff_sha256 }, snap.patch, io), /Checkpoint/, failure);
  }
});
