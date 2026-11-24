import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BuilderStore } from './db/builder-jobs.js';
import { BuilderOutput, MAX_LOG_BYTES, appendEvent, readEvents, redact, matchesProcess, processIdentity, signalGroup, specialistSandbox } from './builder-job-io.js';
import { builderOwner, builderTool, liveOrphanedKeeper, openBuilderStore, reconcileJobs, expectedWorker, waitBuilderReady } from './builder-jobs.js';
import { prepareWorkspace, groupMembers, terminateBuilderGroup, waitForBuilderReparent, specialistArgs } from './builder-job-worker.js';
import { safeEnv } from './code-patch.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
function fixture() { const root = mkdtempSync(join(tmpdir(), 'builder-test-')); return { root, close: () => rmSync(root, { recursive: true, force: true }) }; }
function insert(store: BuilderStore, root: string, id = 'a'.repeat(32)) {
  mkdirSync(join(root, id), { mode: 0o700 });
  const logPath = join(root, id, 'events.jsonl'); writeFileSync(logPath, '', { mode: 0o600 });
  return store.insert({ id, ownerThread: 'owner-thread', ownerSession: 'trusted-turn', audience: 'owner', task: 'Fix layout', mode: 'edit', workspace: join(root, 'workspace'), branch: 'boss/test', baseCommit: 'b'.repeat(40), logPath });
}
test('migration, reopen, guarded transitions, immutable ownership, single active slot', () => {
  const f = fixture(); let store = openBuilderStore(f.root);
  try {
    const job = insert(store, f.root);
    assert.throws(() => insert(store, f.root, 'c'.repeat(32)), /UNIQUE/);
    assert.throws(() => store.update(job.id, {}, 'succeeded'), /Invalid/);
    assert.throws(() => store.update(job.id, { ownerThread: 'spoof' }), /Immutable/);
    store.update(job.id, { started: new Date().toISOString() }, 'running');
    store.close(); store = openBuilderStore(f.root);
    assert.equal(store.get(job.id)!.status, 'running');
    store.update(job.id, {}, 'stopping'); store.update(job.id, { report: 'kept' }, 'stopped');
    assert.throws(() => store.update(job.id, {}, 'running'), /Invalid/);
    assert.equal(store.get(job.id)!.report, 'kept');
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'builder_jobs_%'").get() as { n: number }).n, 3);
  } finally { store.close(); f.close(); }
});
test('redacts tokens, assignments, URLs, JSON, split chunks, multiline PEM and overlong tails', () => {
  const secret = 'test-api-key';
  assert.ok(!redact(`OPENAI_API_KEY=${secret} Authorization: Bearer ${secret} https://bob:password@host`).includes(secret));
  assert.ok(!redact('{"refresh_token":"private-value"}').includes('private-value'));
  const lines: string[] = [], output = new BuilderOutput(line => lines.push(line));
  output.write('API_TOKEN=split'); output.write('secret\n-----BEGIN PRIVATE'); output.write(' KEY-----\nBASE64_PRIVATE_BYTES\n');
  output.write('-----END PRIVATE KEY-----\nnormal ✓\n');
  output.write('X'.repeat(25000)); output.write('continuation-secret\nnext\n'); output.write('PASSWORD=last-secret', true);
  const text = lines.join('\n');
  for (const value of ['splitsecret', 'BASE64_PRIVATE_BYTES', 'continuation-secret', 'last-secret']) assert.ok(!text.includes(value), value);
  assert.ok(text.includes('normal ✓')); assert.ok(text.includes('next'));
});
test('append-only bounded JSONL with event cursors and safe file ownership', () => {
  const f = fixture(), path = join(f.root, 'log');
  try {
    const first = appendEvent(path, 'output', 'PASSWORD=hunter2'); appendEvent(path, 'phase', 'done');
    const result = readEvents(path, 0, first); assert.equal(result.events.length, 1); assert.equal(result.cursor, first);
    assert.ok(!readFileSync(path, 'utf8').includes('hunter2'));
    assert.equal(readEvents(path, first).events.length, 1);
    assert.throws(() => readEvents(path, 1), /boundary/);
    assert.throws(() => readEvents(path, MAX_LOG_BYTES + 1), /cursor/);
    assert.throws(() => appendEvent(path, 'output', 'too much', first), /limit/);
    assert.equal(readEvents(path, readEvents(path).cursor).events.length, 0);
  } finally { f.close(); }
});
test('trusted explicit owner turns and owner autonomous turns allowed, missing/guest denied before effects', async () => {
  assert.equal(builderOwner({ threadId: 't', turnId: 's', audience: { kind: 'owner' }, isAutonomous: true }).audience, 'owner');
  for (const ctx of [undefined, {}, { threadId: 't', turnId: 's' }, { threadId: 't', turnId: 's', audience: { kind: 'guest', trust: 'full' } }]) {
    assert.throws(() => builderOwner(ctx as never), /owner/);
    assert.equal((await builderTool('start', { task: 'hello', audience: 'owner' }, ctx as never)).ok, false);
  }
});
test('restart reconciliation keeps matching workers, orphans dead/mismatch, retains workspace', () => {
  const f = fixture(), store = openBuilderStore(f.root);
  try {
    const job = insert(store, f.root); mkdirSync(job.workspace); writeFileSync(join(job.workspace, 'unsaved.txt'), 'keep');
    store.update(job.id, { workerPid: 123, workerStarttime: '55', workerPgid: 123 }, 'running');
    reconcileJobs(store, 'unused', Date.now(), () => true); assert.equal(store.get(job.id)!.status, 'running');
    reconcileJobs(store, 'unused', Date.now(), () => false); assert.equal(store.get(job.id)!.status, 'orphaned');
    assert.equal(readFileSync(join(job.workspace, 'unsaved.txt'), 'utf8'), 'keep');
  } finally { store.close(); f.close(); }
});
test('process reuse or command substitution never receives a signal', () => {
  const expected = { pid: 100, starttime: '12', pgid: 100, commandHash: 'good' };
  let signals = 0;
  for (const actual of [null, { ...expected, starttime: '13' }, { ...expected, commandHash: 'other' }, { ...expected, pgid: 200 }]) {
    assert.equal(signalGroup(expected, 'SIGTERM', () => actual, (() => { signals++; return true; }) as typeof process.kill), false);
  }
  assert.equal(signals, 0); assert.equal(matchesProcess(expected, () => expected), true);
});
test('actual TERM/KILL stops a group including a stubborn grandchild; fixture workspace retained', async () => {
  const f = fixture(); const script = join(f.root, 'keeper.cjs');
  writeFileSync(script, `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((resolvePromise, reject) => { child.stdout!.once('data', () => resolvePromise()); child.once('error', reject); });
    const identity = processIdentity(child.pid!)!; assert.ok(identity); assert.ok(groupMembers(identity.pgid).length >= 2);
    await terminateBuilderGroup(identity, 100);
    assert.equal(groupMembers(identity.pgid).length, 0); assert.ok(existsSync(script));
  } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} f.close(); }
});
test('reparent wait is bounded and readiness checks exact command/start identity', async () => {
  let calls = 0; await waitForBuilderReparent(55, () => ++calls > 2 ? 1 : 55, 1000);
  await assert.rejects(waitForBuilderReparent(55, () => 55, 30), /reparent/);
  const f = fixture(), store = openBuilderStore(f.root);
  const id = 'a'.repeat(32), script = join(f.root, 'worker.cjs'); writeFileSync(script, 'setInterval(()=>{},1000)');
  const child = spawn(process.execPath, [script, id, f.root], { detached: true, stdio: 'ignore' });
  try {
    await new Promise<void>(r => child.once('spawn', () => r()));
    const job = insert(store, f.root, id), pid = processIdentity(child.pid!)!;
    store.update(id, { workerPid: pid.pid, workerStarttime: pid.starttime, workerPgid: pid.pgid, started: new Date().toISOString() }, 'running');
    assert.ok(expectedWorker(store.get(id)!, script));
    assert.equal((await waitBuilderReady(store, id, script, 500)).id, id);
    store.update(id, { workerStarttime: 'wrong' });
    await assert.rejects(waitBuilderReady(store, id, script, 50), /timed out/);
    assert.equal(job.workspace, store.get(id)!.workspace);
  } finally { process.kill(-child.pid!, 'SIGKILL'); store.close(); f.close(); }
});
test('specialist gets filtered environment, ordinary edit/network permissions, inspect read-only', () => {
  const env = safeEnv('/fixture/home'); assert.equal(env.HOME, '/fixture/home');
  for (const key of ['VPS_ROOT_PASSWORD', 'OPENAI_API_KEY', 'DATABASE_URL', 'NODE_OPTIONS', 'LD_PRELOAD']) assert.equal(env[key], undefined);
  const edit = specialistArgs('ordinary task', 'edit'); assert.ok(edit.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(edit.at(-1)!.includes('No per-file approval')); assert.ok(edit.at(-1)!.includes('Never read or modify production'));
  assert.ok(specialistArgs('inspect', 'inspect').includes('read-only'));
});
test('sandbox has writable job/home/git, read-only host, PID namespace, normal network', () => {
  const args = specialistSandbox({ cwd: '/srv/job', home: '/srv/home', commonGit: '/srv/repo/.git', args: ['exec'] });
  assert.ok(args.includes('--unshare-pid')); assert.ok(args.includes('--die-with-parent')); assert.ok(!args.includes('--unshare-net'));
  assert.ok(args.includes('--ro-bind')); assert.ok(args.includes('/srv/job')); assert.equal(args.at(-2), '/usr/bin/codex');
});

test('fixture Git worktree pins baseline, rejects drift/dirty, preserves workspace after failure', () => {
  const f = fixture(), store = openBuilderStore(f.root);
  const source = join(f.root, 'source'), home = join(f.root, 'home'), workRoot = join(f.root, 'jobs');
  mkdirSync(source); mkdirSync(home);
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env: { ...safeEnv(home), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).toString().trim();
  try {
    git(['init', '-q']); writeFileSync(join(source, 'file.txt'), 'baseline'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const job = insert(store, f.root);
    // Fixture job fields are immutable after insertion, so build the explicit fixture input.
    const input = { ...job, workspace: join(workRoot, job.id), baseCommit: git(['rev-parse', 'HEAD']) };
    const cfg = { root: f.root, workRoot, source, base: 'HEAD', home, uid: process.getuid!(), gid: process.getgid!(), timeoutMs: 1000 };
    writeFileSync(join(source, 'dirty.txt'), 'pending'); assert.throws(() => prepareWorkspace(cfg, input), /baseline changed/);
    rmSync(join(source, 'dirty.txt'));
    assert.throws(() => prepareWorkspace(cfg, { ...input, baseCommit: '0'.repeat(40) }), /baseline changed/);
    prepareWorkspace(cfg, input); assert.equal(readFileSync(join(input.workspace, 'file.txt'), 'utf8'), 'baseline');
    writeFileSync(join(input.workspace, 'new.txt'), 'retained');
    assert.throws(() => prepareWorkspace(cfg, input), /exists/); assert.ok(existsSync(join(input.workspace, 'new.txt')));
  } finally { store.close(); f.close(); }
});

test('sandbox fixture permits workspace/network, blocks host writes and root paths', () => {
  const f = { root: mkdtempSync('/var/tmp/builder-sandbox-test-'), close() { rmSync(this.root, { recursive: true, force: true }); } }; const workspace = join(f.root, 'work'), home = join(f.root, 'home'), git = join(f.root, 'git');
  for (const path of [workspace, home, git]) mkdirSync(path);
  const sentinel = join(f.root, 'outside'); writeFileSync(sentinel, 'untouched');
  try {
    const args = specialistSandbox({ cwd: workspace, home, commonGit: git, args: [] }); args.pop();
    const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(workspace, 'ok'))},'written');let denied=false;try{fs.writeFileSync(${JSON.stringify(sentinel)},'bad')}catch{denied=true}if(!denied)process.exit(2);if(fs.existsSync('/srv/bytelight-public'))process.exit(3);const a=fs.readFileSync('/proc/self/ns/net');`;
    // Network namespace identity is checked outside rather than opening any network connection.
    const script = code.replace("const a=fs.readFileSync('/proc/self/ns/net');", `if(fs.readlinkSync('/proc/self/ns/net')!==${JSON.stringify(execFileSync('/usr/bin/readlink', ['/proc/self/ns/net']).toString().trim())})process.exit(4);`);
    const resolverCheck = `if(fs.readFileSync('/etc/resolv.conf','utf8')!==${JSON.stringify(readFileSync('/etc/resolv.conf', 'utf8'))})process.exit(5);`;
    execFileSync('/usr/bin/bwrap', [...args, process.execPath, '-e', script + resolverCheck], { env: safeEnv(home), timeout: 5000 });
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched'); assert.equal(readFileSync(join(workspace, 'ok'), 'utf8'), 'written');
  } finally { f.close(); }
});

test('orphaned live keeper fences replacement; mismatched or dead PID releases fence', async () => {
  const f = fixture(), store = openBuilderStore(f.root), script = join(f.root, 'keeper.cjs');
  writeFileSync(script, 'setInterval(()=>{},1000)');
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  try {
    await new Promise<void>(r => child.once('spawn', () => r()));
    const job = insert(store, f.root), pid = processIdentity(child.pid!)!;
    store.update(job.id, { childPid: pid.pid, childStarttime: pid.starttime, childPgid: pid.pgid }, 'running');
    store.update(job.id, { currentPhase: 'cleanup-uncertain' }, 'orphaned');
    assert.equal(liveOrphanedKeeper(store, script), true);
    assert.equal(liveOrphanedKeeper(store, '/wrong-command'), false);
    assert.equal(liveOrphanedKeeper(store, script, () => ({ ...pid, starttime: 'reused' })), false);
    assert.equal(liveOrphanedKeeper(store, script, () => null), false);
  } finally { process.kill(-child.pid!, 'SIGKILL'); store.close(); f.close(); }
});

test('worker orchestration succeeds/stops/times out with retained worktrees and no real Codex', async () => {
  const { runBuilderWorker } = await import('./builder-job-worker.js');
  for (const scenario of ['success', 'stop', 'timeout'] as const) {
    const f = fixture(), store = openBuilderStore(f.root), id = 'a'.repeat(32), dir = join(f.root, id);
    mkdirSync(dir, { mode: 0o700 });
    const workspace = join(f.root, 'workspace'), home = join(f.root, 'home'); mkdirSync(home);
    const cfg = { root: f.root, workRoot: f.root, source: workspace, base: 'HEAD', home, uid: process.getuid!(), gid: process.getgid!(), timeoutMs: scenario === 'timeout' ? 150 : 2000 };
    const logPath = join(dir, 'events.jsonl'); writeFileSync(logPath, '', { mode: 0o600 });
    const script = join(f.root, 'keeper.cjs');
    writeFileSync(script, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.on('message',()=>{process.send({type:'output',text:'API_TOKEN=fixture-secret\\nreport line\\n'});${scenario === 'success' ? "process.send({type:'done',code:0});" : ''}});`);
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ config: cfg, workerPath: 'fixture' }), { mode: 0o600 });
    const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: workspace, env: { ...safeEnv(home), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).toString().trim();
    mkdirSync(workspace); git(['init', '-q']); writeFileSync(join(workspace, 'baseline'), 'baseline'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
    store.insert({ id, ownerThread: 'thread', ownerSession: 'turn', audience: 'owner', task: 'fixture', mode: 'edit', workspace, branch: 'boss/test', baseCommit: git(['rev-parse', 'HEAD']), logPath });
    let keeperPid = 0;
    const running = runBuilderWorker(id, f.root, {
      self: () => ({ ...processIdentity(process.pid)!, pgid: process.pid }),
      prepare: () => { writeFileSync(join(workspace, 'pending.txt'), 'retained'); },
      spawnKeeper: () => {
        const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); keeperPid = child.pid!; return child;
      },
    });
    try {
      if (scenario === 'stop') {
        for (let attempt = 0; attempt < 100 && !store.get(id)!.childPid; attempt++) await pause(10);
        store.update(id, {}, 'stopping');
      }
      await running;
      assert.equal(store.get(id)!.status, scenario === 'success' ? 'succeeded' : scenario === 'stop' ? 'stopped' : 'failed');
      assert.ok(existsSync(join(workspace, 'pending.txt')));
      assert.ok(!readFileSync(logPath, 'utf8').includes('fixture-secret'));
      assert.ok(!store.get(id)!.report?.includes('fixture-secret'));
      assert.equal(groupMembers(keeperPid).length, 0);
    } finally { try { process.kill(-keeperPid, 'SIGKILL'); } catch {} store.close(); f.close(); }
  }
});

test('real detached launcher reparents, reopens fixture DB, records readiness/failure without coding', async () => {
  const f = fixture(), store = openBuilderStore(f.root), job = insert(store, f.root);
  const worker = fileURLToPath(new URL('../../dist/services/builder-job-worker.js', import.meta.url));
  assert.ok(existsSync(worker), 'build backend before detached integration fixture');
  const cfg = { root: f.root, workRoot: join(f.root, 'work'), source: join(f.root, 'missing-fixture-source'), base: 'HEAD', home: join(f.root, 'home'), uid: process.getuid!(), gid: process.getgid!(), timeoutMs: 1000 };
  writeFileSync(join(f.root, job.id, 'request.json'), JSON.stringify({ config: cfg, workerPath: worker }), { mode: 0o600 });
  const child = spawn(process.execPath, [worker, '--launch', job.id, f.root], { detached: true, cwd: '/', env: safeEnv('/nonexistent'), stdio: 'ignore' });
  try {
    await new Promise<void>((r, reject) => { child.once('exit', code => code === 0 ? r() : reject(new Error(`launcher ${code}`))); child.once('error', reject); });
    const ready = await waitBuilderReady(store, job.id, worker, 5000);
    assert.ok(ready.workerPid); assert.ok(ready.workerStarttime); assert.ok(ready.started);
    for (let attempt = 0; attempt < 100 && store.get(job.id)!.status === 'running'; attempt++) await pause(20);
    assert.equal(store.get(job.id)!.status, 'failed'); assert.ok(store.get(job.id)!.finished);
  } finally { store.close(); f.close(); }
});

test('PID namespace tears down a setsid descendant outside the coding process group', async () => {
  const f = { root: mkdtempSync('/var/tmp/builder-namespace-test-'), close() { rmSync(this.root, { recursive: true, force: true }); } };
  const workspace = join(f.root, 'work'), home = join(f.root, 'home'), git = join(f.root, 'git');
  for (const path of [workspace, home, git]) mkdirSync(path);
  const token = `builder-setsid-${Date.now()}-${process.pid}`;
  const args = specialistSandbox({ cwd: workspace, home, commonGit: git, args: [] }); args.pop();
  const inner = `require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",${JSON.stringify(token)}],{detached:true,stdio:'ignore'}).unref();console.log('namespace-ready');setInterval(()=>{},1000);`;
  const script = join(f.root, 'keeper.cjs');
  writeFileSync(script, `process.on('SIGTERM',()=>{});require('node:child_process').spawn('/usr/bin/bwrap',${JSON.stringify([...args, process.execPath, '-e', inner])},{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let escaped: ReturnType<typeof processIdentity> = null;
  try {
    await new Promise<void>((r, reject) => { const timeout = setTimeout(() => reject(new Error('namespace fixture readiness timeout')), 5000); child.stdout!.once('data', () => { clearTimeout(timeout); r(); }); child.once('error', reject); });
    const { readdirSync } = await import('node:fs');
    for (const name of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        const cmd = readFileSync(`/proc/${name}/cmdline`).toString().split('\0');
        if (cmd.includes(token)) { escaped = processIdentity(Number(name)); break; }
      } catch { /* process exited */ }
    }
    assert.ok(escaped, 'find real host PID of namespace descendant'); assert.notEqual(escaped.pgid, child.pid);
    await terminateBuilderGroup(processIdentity(child.pid!)!, 100);
    for (let attempt = 0; attempt < 100 && processIdentity(escaped.pid); attempt++) await pause(20);
    assert.equal(processIdentity(escaped.pid), null);
  } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} f.close(); }
});
