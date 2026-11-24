import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { approved, deployCode, deployCodeStatus, validateFiles, protectedCompiledPaths, privilegedManifest, createImmutablePatch, workerEnv, startDetachedWorker, waitForReparent, cleanStartingLock, workerReady } from './code-deployment.js';
import { pendingPatch, safeEnv, identity, execution } from './code-patch.js';

// Independent contract: omitting a protected module from the implementation
// must fail the sealing test rather than silently shrinking its fixture.
const expectedProtectedCompiledPaths = [
  'packages/backend/dist/services/builder-deployment.js',
  'packages/backend/dist/services/builder-release-bundle.js',
  'packages/backend/dist/services/builder-release-dependencies.js',
  'packages/backend/dist/services/builder-release-ci.js',
  'packages/backend/dist/services/code-deployment.js',
  'packages/backend/dist/services/code-deployment-worker.js',
  'packages/backend/dist/services/code-patch.js',
  'packages/backend/dist/services/code-authorization.js',
  'packages/backend/dist/services/code-checkpoint.js',
  'packages/backend/dist/services/code-delegation.js',
  'packages/backend/dist/services/chat-tool-belt.js',
  'packages/backend/dist/services/agent.js',
  'packages/backend/dist/services/agent/turn-input.js',
  'packages/backend/dist/services/turn-origin.js', 'packages/backend/dist/services/turn-audience.js',
  'packages/backend/dist/services/mcp-bridge.js',
  'packages/backend/dist/services/mcp-belt-auth.js',
  'packages/backend/dist/services/telegram/config.js', 'packages/backend/dist/services/telegram/debouncer.js', 'packages/backend/dist/services/discord/config.js', 'packages/backend/dist/services/discord/debouncer.js', 'packages/backend/dist/middleware/auth.js', 'packages/backend/dist/routes/api.js', 'packages/backend/dist/config.js',
  'packages/backend/dist/services/ws.js', 'packages/backend/dist/services/discord/index.js', 'packages/backend/dist/services/telegram/index.js',
  'packages/backend/dist/services/living-room-relay.js', 'packages/backend/dist/services/room-turns.js', 'packages/backend/dist/services/commands.js',
  'packages/backend/dist/routes/messages.js', 'packages/backend/dist/routes/cards.js', 'packages/backend/dist/routes/battleship.js',
  'packages/backend/dist/services/story-shelf.js', 'packages/backend/dist/services/library-book-club-turns.js', 'packages/backend/dist/routes/rooms-routes.js',
  'packages/backend/dist/routes/mcp-belt.js',
  'packages/backend/dist/services/runtimes/codex-daemon.js',
  'packages/backend/dist/services/runtimes/types.js',
];

test('live positive approval required, never model arguments or wake approval', async () => {
  const args = { branch: 'codex/test', diff_sha256: 'a'.repeat(64), confirmation: 'DEPLOY' };
  for (const ctx of [undefined, {}, { rawOwnerMessageText: 'deploy', isAutonomous: true }, { rawOwnerMessageText: 'do not deploy', isAutonomous: false }, { rawOwnerMessageText: 'not yet, ship it', isAutonomous: false }, { rawOwnerMessageText: 'cancel deploy', isAutonomous: false }, { rawOwnerMessageText: 'deploy', isAutonomous: false, audience: { kind: 'guest' as const, trust: 'full' as const } }]) {
    assert.equal((await deployCode(args, ctx)).ok, false);
    assert.equal(approved(ctx), false);
  }
  for (const text of ['deploy', "let's deploy", 'ship it', 'put it live', 'push it live', 'Lets deploy!', "LET’S DEPLOY!", "Let's deploy."]) assert.equal(approved({ audience: { kind: 'owner' }, turnId: 'trusted-test', ownerMessageId: 'owner-message', proposalMessageId: 'proposal-message', threadId: 'test', rawOwnerMessageText: text, isAutonomous: false }), false);
  for (const text of ['do not deploy', 'don’t deploy', 'never ship it', 'deploy later', '> deploy', 'deploy\nQuoted approval', 'she said deploy', 'ship it?', 'deploy; rm -rf /']) assert.equal(approved({ audience: { kind: 'owner' }, turnId: 'trusted-test', ownerMessageId: 'owner-message', proposalMessageId: 'proposal-message', threadId: 'test', rawOwnerMessageText: text, isAutonomous: false }), false);
  const res = await deployCode({ ...args, branch: '../bad' }, { audience: { kind: 'owner' }, turnId: 'trusted-test', ownerMessageId: 'owner-message', proposalMessageId: 'proposal-message', threadId: 'test', rawOwnerMessageText: 'deploy', isAutonomous: false });
  assert.match(res.result, /Invalid codex branch/);
});
test('status is read only and binds branch', async (t) => {
  if (process.getuid?.() !== 0) return t.skip('Privileged status store requires root-owned fixture');
  const dir = mkdtempSync(join(tmpdir(), 'bl-status-'));
  const old = process.env.BYTELIGHT_CODE_STATE_DIR; process.env.BYTELIGHT_CODE_STATE_DIR = dir;
  try {
    const hash = 'a'.repeat(64), path = join(dir, `${hash}.json`);
    writeFileSync(path, JSON.stringify({ branch: 'codex/test', status: 'pending' }));
    const before = readFileSync(path);
    assert.equal((await deployCodeStatus({ branch: 'codex/test', diff_sha256: hash })).ok, true);
    assert.equal((await deployCodeStatus({ branch: 'codex/other', diff_sha256: hash })).ok, false);
    assert.deepEqual(readFileSync(path), before);
  } finally { if (old === undefined) delete process.env.BYTELIGHT_CODE_STATE_DIR; else process.env.BYTELIGHT_CODE_STATE_DIR = old; rmSync(dir, { recursive: true }); }
});
test('canonical patch includes staged, deleted, binary and new files without changing index', (t) => {
  try { execFileSync('/usr/bin/git', ['--version'], { env: safeEnv() }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Sandbox denies Node subprocesses; run this fixture on unrestricted CI'); throw e; }
  const dir = mkdtempSync(join(tmpdir(), 'bl-patch-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: dir, env: safeEnv() });
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(dir, 'old'), 'old'); writeFileSync(join(dir, 'deleted'), 'delete'); git('add', '.'); git('commit', '-m', 'fixture');
    writeFileSync(join(dir, 'old'), 'staged'); git('add', 'old'); writeFileSync(join(dir, 'old'), 'working tree'); rmSync(join(dir, 'deleted'));
    writeFileSync(join(dir, 'binary'), Buffer.from([0, 1, 255])); writeFileSync(join(dir, 'new'), 'new');
    writeFileSync(join(dir, '.gitignore'), 'ignored-new'); writeFileSync(join(dir, 'ignored-new'), 'staged ignored file'); git('add', '-f', 'ignored-new');
    const frozenIndex = readFileSync(join(dir, '.git/index'));
    const snap = pendingPatch(dir);
    assert.deepEqual(snap.files.sort(), ['.gitignore', 'binary', 'deleted', 'ignored-new', 'new', 'old']); assert.match(snap.patch.toString(), /GIT binary patch/);
    assert.match(snap.patch.toString(), /working tree/); assert.equal(snap.diff_sha256, createHash('sha256').update(snap.patch).digest('hex')); assert.deepEqual(readFileSync(join(dir, '.git/index')), frozenIndex);
    assert.equal(pendingPatch(dir).diff_sha256, snap.diff_sha256);
    writeFileSync(join(dir, 'binary'), Buffer.from([0, 1, 254]));
    assert.notEqual(pendingPatch(dir).diff_sha256, snap.diff_sha256);
    writeFileSync(join(dir, 'new'), 'changed untracked');
    assert.notEqual(pendingPatch(dir).diff_sha256, snap.diff_sha256);
    symlinkSync('/tmp', join(dir, 'link')); assert.throws(() => pendingPatch(dir), /Symlink/); rmSync(join(dir, 'link'));
    writeFileSync(join(dir, '.env.test'), 'fixture'); assert.throws(() => pendingPatch(dir), /Blocked path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('blocked manifests and strict identity/environment', () => {
  for (const file of ['package.json', 'package-lock.json', '.github/workflows/test.yml', 'script.sh', 'vite.config.ts', 'packages/backend/dist/server.js', 'packages/frontend/build/index.html', 'packages/backend/src/services/code-deployment-worker.ts', 'nested/npm-shrinkwrap.json', 'nested/yarn.lock', 'pnpm-lock.yaml', 'scripts/build.js', '.npmrc', '../escape', '/absolute', '.bl-source.tar']) assert.throws(() => validateFiles([file]), /Manual maintenance/);
  assert.doesNotThrow(() => validateFiles(['packages/backend/src/example.ts']));
  assert.deepEqual(Object.keys(safeEnv()).sort(), ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'NO_COLOR', 'PATH', 'TERM', 'USER'].sort());
  if (process.getuid?.() === 0) assert.deepEqual(execution('/usr/bin/node', ['test'], { uid: 63002, gid: 63002 }), { file: '/usr/bin/setpriv', args: ['--reuid=63002', '--regid=63002', '--clear-groups', '--no-new-privs', '--', '/usr/bin/node', 'test'] });
  assert.equal(workerEnv().NODE_OPTIONS, undefined);
  assert.equal(workerEnv().BYTELIGHT_CODEX_HOME, undefined);
  assert.throws(() => identity('BL_TEST_ABSENT'), /nonzero/);
  for (const uid of ['0', '-1', 'abc', '0x10', '1.0', '4294967295']) {
    process.env.BL_FIXTURE_UID = uid; process.env.BL_FIXTURE_GID = '1';
    assert.throws(() => identity('BL_FIXTURE'), /nonzero/);
  }
  delete process.env.BL_FIXTURE_UID; delete process.env.BL_FIXTURE_GID;
});

test('isolated promotion and coherent rollback at copy/restart/health boundaries', async (t) => {
  const { chmodSync, chownSync, cpSync, existsSync } = await import('node:fs');
  const { runDeployment } = await import('./code-deployment.js');
  for (const failure of ['none', 'transient-health', 'copy', 'restart', 'health', 'fingerprint', 'branch', 'baseline', 'blocked', 'pm2', 'invalid-pid', 'changing-pid', 'changing-restarts', 'duplicate', 'root-runtime', 'rollback-stop', 'rollback-database', 'artifact-symlink', 'finalization', 'validation', 'checkpoint-recovery']) await t.test(failure, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bl-deployment-')); chmodSync(root, 0o755);
    const names = ['dev', 'prod', 'stage', 'backup', 'state'];
    for (const name of names) mkdirSync(join(root, name), { mode: name === 'state' ? 0o700 : 0o755 });
    const dev = join(root, 'dev'), prod = join(root, 'prod');
    const env = {
      BYTELIGHT_CODE_WORKSPACE: dev, BYTELIGHT_CODE_PRODUCTION: prod,
      BYTELIGHT_CODE_STAGING_DIR: join(root, 'stage'), BYTELIGHT_CODE_BACKUP_DIR: join(root, 'backup'), BYTELIGHT_CODE_STATE_DIR: join(root, 'state'),
      BYTELIGHT_CODE_HEALTH_URL: 'http://127.0.0.1:1234/api/health', BYTELIGHT_CODE_PM2_APP: 'fixture', BYTELIGHT_CODE_SQLITE_PATH: join(prod, 'fixture.sqlite'),
      BYTELIGHT_CODEX_UID: '63001', BYTELIGHT_CODEX_GID: '63001', BYTELIGHT_BUILD_UID: '63002', BYTELIGHT_BUILD_GID: '63002',
    };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
    const artifacts = ['packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
    const commands: { file: string; args: string[]; cwd: string; uid?: number }[] = [];
    try {
      const head = 'a'.repeat(40);
      writeFileSync(join(dev, 'source.ts'), 'after'); writeFileSync(join(dev, 'new.ts'), 'new');

      writeFileSync(join(prod, 'source.ts'), 'before'); writeFileSync(join(prod, 'fixture.sqlite'), 'database-before');
      writeFileSync(join(prod, 'package-lock.json'), '{\"lockfileVersion\":3}');
      for (const path of artifacts) { mkdirSync(join(prod, path), { recursive: true }); writeFileSync(join(prod, path, 'artifact'), 'old-build'); }
      mkdirSync(join(prod, 'packages/backend/dist/services'));
      for (const relative of expectedProtectedCompiledPaths) { mkdirSync(dirname(join(prod, relative)), { recursive: true }); writeFileSync(join(prod, relative), 'trusted-coordinator'); }
      const snap = { tree: 'd'.repeat(40), patch: Buffer.from('fixture-patch'), files: failure === 'blocked' ? ['package.json'] : ['source.ts', 'new.ts'], diff_sha256: 'b'.repeat(64) }, key = snap.diff_sha256, state = join(root, 'state');
      writeFileSync(join(state, `${key}.request`), JSON.stringify({ branch: 'codex/fixture', diff_sha256: key, head, files: snap.files }));
      writeFileSync(join(state, `${key}.patch`), snap.patch); writeFileSync(join(state, 'deploy.lock'), JSON.stringify({ key }));
      let restart = 0, health = 0, reads = 0, copied = false;
      await runDeployment(key, {
        configuration() { return { dev, prod, staging: join(root, 'stage'), backup: join(root, 'backup'), state, builder: { uid: 63002, gid: 63002 }, app: 'fixture', health: env.BYTELIGHT_CODE_HEALTH_URL, sqlite: env.BYTELIGHT_CODE_SQLITE_PATH }; },
        finalize() { assert.equal(JSON.parse(readFileSync(join(state, `${key}.json`), 'utf8')).lifecycle, 'Live'); if (failure === 'checkpoint-recovery') throw new Error('Recovery Required: injected ref restoration failure'); if (failure === 'finalization') throw new Error('injected checkpoint failure'); return { checkpoint_id: 'e'.repeat(40), development_main_head: 'e'.repeat(40), tree: 'd'.repeat(40), development_clean: true, production_clean: true, synchronized: true }; },
        readTrustedFile: readFileSync,
        chown() {},
        snapshot(cwd, mode) { if (mode) { assert.equal(cwd, prod); assert.deepEqual(mode.expectedFiles, []); return { ...snap, files: [] }; } return failure === 'fingerprint' ? { ...snap, diff_sha256: 'c'.repeat(64) } : snap; },
        git(cwd, args) { return Buffer.from(args[0] === 'status' ? '' : args[0] === 'branch' ? (failure === 'branch' ? 'codex/wrong' : 'codex/fixture') : args[0] === 'rev-parse' ? (failure === 'baseline' && cwd === prod ? 'wrong' : head) : 'fixture-archive'); },
        run(file, args, cwd, options) {
          commands.push({ file, args, cwd, uid: options?.uid });
          if (file === '/usr/bin/npm' || (file === '/usr/bin/node' && options)) {
            assert.equal(JSON.parse(readFileSync(join(state, `${key}.json`), 'utf8')).lifecycle, 'Validating');
            if (failure === 'validation') throw new Error('injected validation failure');
            assert.equal(options?.uid, 63002); assert.equal(options?.gid, 63002);
            assert.equal(options?.env.HOME?.startsWith(join(root, 'stage')), true);
            assert.equal(options?.env.BYTELIGHT_CODE_PM2_APP, undefined);
            assert.notEqual(cwd, prod);
            if (args.join(' ') === 'run build') for (const path of artifacts) { mkdirSync(join(cwd, path), { recursive: true }); if (failure === 'artifact-symlink') symlinkSync('/tmp', join(cwd, path, 'artifact')); else writeFileSync(join(cwd, path, 'artifact'), 'new-build'); }
            if (args.join(' ') === 'run build') for (const relative of expectedProtectedCompiledPaths) { mkdirSync(dirname(join(cwd, relative)), { recursive: true }); writeFileSync(join(cwd, relative), 'untrusted-built-coordinator'); }
            return;
          }
          if (file === '/usr/bin/pm2') {
            if (args[0] === 'jlist') return JSON.stringify(Array.from({ length: failure === 'duplicate' ? 2 : 1 }, () => ({ name: 'fixture', pid: failure === 'invalid-pid' ? 0 : failure === 'changing-pid' && restart === 1 ? ++reads : 123, pm2_env: { status: failure === 'pm2' ? 'errored' : 'online', uid: failure === 'root-runtime' ? 0 : 63003, restart_time: failure === 'changing-restarts' && restart === 1 ? ++reads : restart } })));
            if (args[0] === 'stop' && restart > 0 && failure === 'rollback-stop') throw new Error('injected stop');
            if (args[0] === 'restart' && ++restart === 1) { if (readFileSync(join(prod, 'source.ts'), 'utf8') === 'after') writeFileSync(join(prod, 'fixture.sqlite'), 'database-after'); if (['restart', 'rollback-stop', 'rollback-database'].includes(failure)) throw new Error('injected restart'); } return;
          }
          if (file === '/usr/bin/sqlite3') {
            const target = args[1].slice(args[1].indexOf("'") + 1, -1);
            if (args[1].startsWith('.backup')) cpSync(args[0], target);
            else { if (failure === 'rollback-database') throw new Error('injected restore'); cpSync(target, args[0]); }
            return;
          }
          if (file === '/usr/bin/git' && !args.includes('--check')) {
            writeFileSync(join(cwd, 'source.ts'), 'after'); writeFileSync(join(cwd, 'new.ts'), 'new');
          }
          // tar/chown/git process boundaries are injected; no real production or subprocess is used.

        },
        promote(source, target) { if (!copied && failure === 'copy') { copied = true; throw new Error('injected copy'); } cpSync(source, target, { recursive: true }); },
        async health() { if (++health === 2 && failure === 'transient-health') throw new Error('transient health'); if (health >= 4 && restart === 1 && failure === 'health') throw new Error('injected health'); },
      });
      if (failure === 'checkpoint-recovery') {
        assert.equal(commands.filter(c => c.file === '/usr/bin/sqlite3' && c.args[1].startsWith('.restore')).length, 0);
        assert.equal(restart, 1);
        assert.equal(commands.at(-1)?.args[0], 'stop');
      }
      const result = JSON.parse(readFileSync(join(state, `${key}.json`), 'utf8'));
      for (const relative of expectedProtectedCompiledPaths) assert.equal(readFileSync(join(prod, relative), 'utf8'), 'trusted-coordinator', relative);
      assert.equal(result.lifecycle, ['none', 'transient-health', 'root-runtime'].includes(failure) ? 'Clean' : result.status === 'rolled_back' ? 'Rolled Back' : result.status === 'recovery_required' ? 'Recovery Required' : 'Failed');
      assert.equal(existsSync(join(state, `${createHash('sha256').update('codex/fixture').digest('hex')}.failed`)), !['none', 'transient-health', 'root-runtime'].includes(failure));
      assert.equal(result.status, ['none', 'transient-health', 'root-runtime'].includes(failure) ? 'deployed' : ['fingerprint', 'branch', 'baseline', 'blocked', 'pm2', 'invalid-pid', 'duplicate', 'artifact-symlink', 'validation'].includes(failure) ? 'failed' : (failure.startsWith('rollback-') || failure === 'checkpoint-recovery') ? 'recovery_required' : 'rolled_back', JSON.stringify(result));
      assert.equal(readFileSync(join(prod, 'source.ts'), 'utf8'), ['none', 'transient-health', 'root-runtime', 'rollback-stop', 'checkpoint-recovery'].includes(failure) ? 'after' : 'before');
      assert.equal(existsSync(join(prod, 'new.ts')), ['none', 'transient-health', 'root-runtime', 'rollback-stop', 'checkpoint-recovery'].includes(failure));
      for (const path of artifacts) assert.equal(readFileSync(join(prod, path, 'artifact'), 'utf8'), ['none', 'transient-health', 'root-runtime', 'rollback-stop', 'checkpoint-recovery'].includes(failure) ? 'new-build' : 'old-build');
      assert.equal(existsSync(join(state, 'deploy.lock')), failure.startsWith('rollback-') || failure === 'checkpoint-recovery');
      assert.equal(existsSync(join(root, 'stage', key)), failure.startsWith('rollback-') || failure === 'checkpoint-recovery');
      assert.equal(existsSync(join(state, `${key}.artifacts`)), failure.startsWith('rollback-') || failure === 'checkpoint-recovery');
      assert.equal(readFileSync(join(prod, 'fixture.sqlite'), 'utf8'), ['none', 'transient-health', 'root-runtime', 'rollback-stop', 'rollback-database', 'checkpoint-recovery'].includes(failure) ? 'database-after' : 'database-before');
      if (failure === 'transient-health') assert.equal(commands.filter(c => c.file === '/usr/bin/pm2' && c.args[0] === 'jlist').length, 8);
      if (failure === 'none') {
        const build = commands.findIndex(c => c.file === '/usr/bin/npm' && c.args.join(' ') === 'run build');
        for (const path of ['packages/frontend/src/lib/utils/model-catalog.test.ts', 'packages/phone/src/lib/model-catalog.test.ts']) {
          const check = commands.findIndex(c => c.file === '/usr/bin/node' && c.args.join(' ') === `--import tsx ${path}`);
          assert.ok(check >= 0 && check < build, `${path} must run before build`);
        }
      }
      if (failure === 'none') assert.equal(commands.filter(c => c.file === '/usr/bin/pm2' && c.args[0] === 'jlist').length, 6);
      for (const cmd of commands.filter(c => ['tar', 'npm', 'node'].some(name => c.file.endsWith('/' + name)) || c.cwd.startsWith(join(root, 'stage')))) assert.equal(cmd.uid, 63002);
      assert.equal(readFileSync(join(prod, 'packages/backend/dist/services/code-deployment.js'), 'utf8'), 'trusted-coordinator');
      assert.equal(commands.some(c => c.cwd === prod && (c.file.endsWith('/npm') || c.file.endsWith('/node'))), false);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(root, { recursive: true, force: true });
    }
  });
});


test('worker handshake succeeds only after ready, bootstrap failures and timeout fail', async (t) => {
  if (process.getuid?.() !== 0) return t.skip('Root-owned handshake requires root fixture');
  const { EventEmitter } = await import('node:events');
  const dir = mkdtempSync(join(tmpdir(), 'bl-handshake-')), key = 'a'.repeat(64);
  try {
    for (const scenario of ['success', 'spawn-error', 'grandchild-failure', 'no-handshake', 'timeout']) {
      rmSync(join(dir, `${key}.ready`), { force: true });
      const promise = startDetachedWorker('/trusted/worker.js', key, dir, (file, args, options) => {
        assert.equal(file, process.execPath);
        assert.deepEqual(args, ['/trusted/worker.js', '--launch', key]);
        assert.equal(options.detached, true); assert.equal(options.env?.NODE_OPTIONS, undefined);
        const child = Object.assign(new EventEmitter(), { unref() {} });
        queueMicrotask(() => {
          child.emit('spawn');
          if (scenario === 'spawn-error') child.emit('error', new Error('injected spawn failure'));
          else if (scenario === 'grandchild-failure') child.emit('exit', 1);
          else {
            child.emit('exit', 0);
            if (scenario === 'success') writeFileSync(join(dir, `${key}.ready`), JSON.stringify({ key, pid: 123 }), { mode: 0o600 });
          }
        });
        return child;
      }, 40);
      if (scenario === 'success') await promise;
      else await assert.rejects(promise, /spawn failure|bootstrap failed|timed out/);
    }
    let ppid = 123;
    await waitForReparent(123, () => ppid, async () => { ppid = 1; });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('committed private-looking public examples permit unrelated patches but refuse changes', (t) => {
  try { execFileSync('/usr/bin/git', ['--version'], { env: safeEnv() }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Sandbox denies Node subprocesses'); throw e; }
  const dir = mkdtempSync(join(tmpdir(), 'bl-public-baseline-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: dir, env: safeEnv(), stdio: 'pipe' });
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    const paths = ['examples/bytelight.yaml', 'packages/phone/.env.example'];
    for (const path of paths) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), 'public example'); }
    writeFileSync(join(dir, 'safe.ts'), 'before'); git('add', '.'); git('commit', '-m', 'public baseline');
    writeFileSync(join(dir, 'safe.ts'), 'after');
    assert.deepEqual(pendingPatch(dir).files, ['safe.ts']);
    for (const path of paths) {
      writeFileSync(join(dir, path), 'changed public example');
      assert.throws(() => pendingPatch(dir), /Blocked path/);
      writeFileSync(join(dir, path), 'public example');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('clean and dirty continuation retain codex branch; new tasks branch from local main', async () => {
  const { prepareEditBranch } = await import('./code-delegation.js');
  for (const dirty of [false, true]) {
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'status' ? (dirty ? ' M safe.ts' : '') : args[0] === 'branch' ? 'codex/existing' : '';
    };
    assert.equal(await prepareEditBranch('/fixture', 'continue', true, git), 'codex/existing');
    assert.equal(calls.some(a => a[0] === 'switch'), false);
    if (dirty) await assert.rejects(prepareEditBranch('/fixture', 'new', false, git), /unreviewed/);
    else {
      assert.match(await prepareEditBranch('/fixture', 'new task', false, git), /^codex\/\d+-new-task$/);
      assert.deepEqual(calls.filter(a => a[0] === 'switch').map(a => a.slice(0, 2)), [['switch', 'main'], ['switch', '-c']]);
    }
  }
});

test('ready handshake is atomic and starting-lock cleanup preserves running or foreign locks', (t) => {
  if (process.getuid?.() !== 0) return t.skip('Root-owned handshake requires root fixture');
  const dir = mkdtempSync(join(tmpdir(), 'bl-ready-lock-')), key = 'd'.repeat(64);
  const lock = join(dir, 'deploy.lock');
  try {
    writeFileSync(lock, JSON.stringify({ key, pid: process.pid, state: 'starting' }));
    workerReady(key, dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${key}.ready`), 'utf8')), { key, pid: process.pid });
    cleanStartingLock(dir, key);
    assert.throws(() => readFileSync(lock), /ENOENT/);
    for (const value of [{ key, pid: process.pid, state: 'running' }, { key: 'other', pid: process.pid, state: 'starting' }]) {
      writeFileSync(lock, JSON.stringify(value)); cleanStartingLock(dir, key);
      assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), value);
    }
    assert.throws(() => workerReady(key, dir), /lock mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('ordinary deployment rejects every authorization, coordinator and origin source or compiled module', () => {
  assert.deepEqual(protectedCompiledPaths, expectedProtectedCompiledPaths);
  for (const entry of privilegedManifest) { assert.throws(() => validateFiles([entry.source]), /Manual maintenance/); assert.throws(() => validateFiles([entry.compiled]), /Manual maintenance/); }
  const protectedSources = [
    'services/code-deployment', 'services/code-deployment-worker', 'services/code-patch',
    'services/code-authorization', 'services/code-checkpoint', 'services/code-delegation',
    'services/chat-tool-belt', 'services/agent', 'services/agent/turn-input', 'services/turn-audience',
    'services/mcp-bridge', 'services/mcp-belt-auth', 'routes/mcp-belt', 'services/runtimes/codex-daemon', 'services/runtimes/types',
  ];
  for (const path of protectedSources) for (const suffix of ['.ts', '.test.ts', '.js']) assert.throws(() => validateFiles([`packages/backend/src/${path}${suffix}`]), /Manual maintenance/, path + suffix);
  for (const path of expectedProtectedCompiledPaths) assert.throws(() => validateFiles([path]), /Manual maintenance/, path);
  assert.doesNotThrow(() => validateFiles(['packages/frontend/src/lib/components/ModelSelector.svelte']));
});


test('delegation surfaces the nested automatic deployment lifecycle', async () => {
  const { delegationLifecycle } = await import('./code-delegation.js');
  assert.equal(delegationLifecycle('inspect'), undefined);
  assert.equal(delegationLifecycle('edit'), 'Editing');
  assert.equal(delegationLifecycle('edit', { ok: true, result: JSON.stringify({ status: 'pending', lifecycle: 'Validating' }) }), 'Validating');
  assert.equal(delegationLifecycle('edit', { ok: false, result: JSON.stringify({ error: 'launch failed' }) }), 'Failed');
});

test('delegation rejects incomplete, guest and wake origins before any coding process', async () => {
  const { delegateCodeTask } = await import('./code-delegation.js');
  const owner = { threadId: 'thread', turnId: 'turn', ownerMessageId: 'owner-message', proposalMessageId: 'proposal-message', rawOwnerMessageText: 'Fix picker', audience: { kind: 'owner' as const }, isAutonomous: false };
  for (const ctx of [undefined, { ...owner, turnId: undefined }, { ...owner, threadId: undefined }, { ...owner, rawOwnerMessageText: undefined }, { ...owner, audience: undefined }, { ...owner, audience: { kind: 'guest' as const, trust: 'full' as const } }, { ...owner, isAutonomous: true }]) {
    for (const mode of ['edit', 'inspect'] as const) {
      const result = await delegateCodeTask({ task: 'Fix picker', mode }, ctx);
      assert.equal(result.ok, false); assert.match(result.result, /Live owner/);
    }
  }
});

test('crash after exclusive patch creation retains original bytes and refuses identical or mismatched retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'bl-crash-')), key = 'a'.repeat(64);
  try {
    const patch = Buffer.from('original');
    createImmutablePatch(root, key, patch);
    for (const retry of [patch, Buffer.from('different')]) {
      assert.throws(() => createImmutablePatch(root, key, retry), /Recovery Required/);
      assert.deepEqual(readFileSync(join(root, `${key}.patch`)), patch);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real Git deployment reaches Clean with nonignored production runtime tree', async (t) => {
  try { execFileSync('/usr/bin/git', ['--version'], { env: safeEnv() }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Sandbox denies Node Git subprocesses'); throw e; }
  const { cpSync, existsSync } = await import('node:fs');
  const { gitBytes } = await import('./code-patch.js');
  const { runDeployment } = await import('./code-deployment.js');
  const root = mkdtempSync(join(tmpdir(), 'bl-real-clean-'));
  const dev = join(root, 'dev'), prod = join(root, 'prod'), state = join(root, 'state');
  const env = { ...safeEnv(), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const artifacts = ['packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
  try {
    for (const name of ['dev', 'prod', 'state', 'stage', 'backup']) mkdirSync(join(root, name));
    for (const repo of [dev, prod]) {
      gitBytes(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, '.gitignore'), 'dist/\nbuild/\n');
      writeFileSync(join(repo, 'source.ts'), 'before');
      gitBytes(repo, ['add', '.']); gitBytes(repo, ['commit', '-m', 'base'], env);
    }
    gitBytes(dev, ['checkout', '-b', 'codex/fixture']);
    writeFileSync(join(dev, 'source.ts'), 'after');
    mkdirSync(join(prod, 'memory-vault/.letta'), { recursive: true });
    const runtime = join(prod, 'memory-vault/.letta/config.json');
    writeFileSync(runtime, 'synthetic nonignored runtime');
    writeFileSync(join(prod, 'package-lock.json'), '{}'); writeFileSync(join(prod, 'fixture.sqlite'), 'fixture database');
    for (const relative of protectedCompiledPaths) { mkdirSync(dirname(join(prod, relative)), { recursive: true }); writeFileSync(join(prod, relative), 'trusted'); }
    const snap = pendingPatch(dev), key = snap.diff_sha256, head = gitBytes(dev, ['rev-parse', 'HEAD']).toString().trim();
    writeFileSync(join(state, `${key}.request`), JSON.stringify({ branch: 'codex/fixture', head, tree: snap.tree, diff_sha256: key, files: snap.files }));
    writeFileSync(join(state, `${key}.patch`), snap.patch); writeFileSync(join(state, 'deploy.lock'), JSON.stringify({ key }));
    let restarts = 0;
    await runDeployment(key, {
      configuration: () => ({ dev, prod, state, staging: join(root, 'stage'), backup: join(root, 'backup'), builder: { uid: 63002, gid: 63002 }, app: 'fixture', health: 'http://127.0.0.1:1/api/health', sqlite: join(prod, 'fixture.sqlite') }),
      readTrustedFile: readFileSync, chown() {},
      git: gitBytes,
      run(file, args, cwd) {
        if (file === '/usr/bin/tar') { execFileSync(file, args, { cwd, env: safeEnv() }); return; }
        if (file === '/usr/bin/git') { gitBytes(cwd, args); return; }
        if (file === '/usr/bin/npm' && args.join(' ') === 'run build') {
          for (const path of artifacts) { mkdirSync(join(cwd, path), { recursive: true }); writeFileSync(join(cwd, path, 'artifact'), 'built'); }
        }
        if (file === '/usr/bin/pm2') {
          if (args[0] === 'restart') restarts++;
          if (args[0] === 'jlist') return JSON.stringify([{ name: 'fixture', pid: 123, pm2_env: { status: 'online', restart_time: restarts } }]);
        }
        if (file === '/usr/bin/sqlite3') { assert.ok(args[1].startsWith('.backup')); cpSync(args[0], args[1].slice(args[1].indexOf("'") + 1, -1)); }
      },
      promote: (source, target) => cpSync(source, target, { recursive: true }),
      async health() {},
    });
    const result = JSON.parse(readFileSync(join(state, `${key}.json`), 'utf8'));
    assert.equal(result.lifecycle, 'Clean', JSON.stringify(result)); assert.equal(result.status, 'deployed');
    assert.equal(readFileSync(runtime, 'utf8'), 'synthetic nonignored runtime');
    assert.equal(existsSync(join(state, 'deploy.lock')), false);
    assert.equal(gitBytes(dev, ['rev-parse', 'HEAD']).toString(), gitBytes(prod, ['rev-parse', 'HEAD']).toString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
