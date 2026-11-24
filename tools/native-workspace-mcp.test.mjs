import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWorkspace } from './native-workspace-mcp.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = path.join(source, 'tools/native-workspace-mcp.mjs');
const sha = content => createHash('sha256').update(content).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const node = js => `${quote(process.execPath)} -e ${quote(js)}`;
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-workspace-test-'));
  const cwd = path.join(directory, 'default'), outside = path.join(directory, 'outside'), stateDir = path.join(directory, 'jobs');
  await fs.mkdir(cwd); await fs.mkdir(outside);
  const options = { cwd, stateDir, sourceRoot: source, configPath: '', ...overrides };
  const workspace = createWorkspace(options);
  t.after(async () => {
    const { jobs } = await workspace.call('workspace_job', { action: 'list' });
    for (const job of jobs) if (['queued', 'running'].includes(job.status)) await workspace.call('workspace_job', { action: 'stop', job_id: job.job_id });
    await sleep(650); await fs.rm(directory, { recursive: true, force: true });
  });
  return { ...workspace, directory, cwd, outside, stateDir, options };
}

test('truthful local host information; no invented Mac connection or path jail', async t => {
  const f = await fixture(t), info = await f.call('workspace_info');
  assert.equal(info.hostname, os.hostname()); assert.equal(info.cwd, await fs.realpath(f.cwd));
  assert.ok(info.capabilities.includes('shell')); assert.match(info.host_scope, /This host only/);
  await f.call('workspace_write', { path: path.join(f.outside, 'hello.txt'), content: 'hello', expected_sha256: 'missing' });
  assert.equal((await f.call('workspace_read', { path: path.join(f.outside, 'hello.txt') })).content, 'hello');
});

test('bounded paged reads and listing, full-file optimistic hash, base64 pages', async t => {
  const f = await fixture(t), value = '0123456789'.repeat(9000);
  await fs.writeFile(path.join(f.cwd, 'large.txt'), value); await fs.writeFile(path.join(f.cwd, 'second.txt'), 'two');
  const page = await f.call('workspace_read', { path: 'large.txt', offset: 9, limit: 11 });
  assert.equal(page.content, value.slice(9, 20)); assert.equal(page.next_offset, 20); assert.equal(page.sha256, sha(value));
  const encoded = await f.call('workspace_read', { path: 'large.txt', offset: 5, limit: 4, encoding: 'base64' });
  assert.equal(Buffer.from(encoded.content, 'base64').toString(), '5678');
  const first = await f.call('workspace_list', { limit: 1 }), second = await f.call('workspace_list', { offset: first.next_offset, limit: 1 });
  assert.equal(first.entries.length, 1); assert.notEqual(first.entries[0].name, second.entries[0].name);
  await assert.rejects(f.call('workspace_read', { path: 'large.txt', limit: 100_000 }), /integer/);
});

test('atomic writes/edits preserve symlink, target permissions and stale-hash conflicts', async t => {
  const f = await fixture(t), target = path.join(f.outside, 'target.txt'), link = path.join(f.cwd, 'link.txt');
  await fs.writeFile(target, 'alpha beta'); await fs.chmod(target, 0o640); await fs.symlink(target, link);
  const initial = await f.call('workspace_read', { path: link });
  const result = await f.call('workspace_edit', { path: link, old_text: 'beta', new_text: '$& updated', expected_sha256: initial.sha256 });
  assert.equal(await fs.readFile(target, 'utf8'), 'alpha $& updated'); assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640); assert.equal(result.sha256, sha('alpha $& updated'));
  await assert.rejects(f.call('workspace_write', { path: link, content: 'stale', expected_sha256: initial.sha256 }), /Conflict/);
  assert.equal(await fs.readFile(target, 'utf8'), 'alpha $& updated');
  const missing = path.join(f.outside, 'new-target.txt'); await fs.symlink(missing, path.join(f.cwd, 'dangling'));
  await f.call('workspace_write', { path: 'dangling', content: 'created', expected_sha256: 'missing' });
  assert.ok((await fs.lstat(path.join(f.cwd, 'dangling'))).isSymbolicLink()); assert.equal(await fs.readFile(missing, 'utf8'), 'created');
});

test('edits require unambiguous text; parent creation is explicit and file errors are truthful', async t => {
  const f = await fixture(t);
  await f.call('workspace_write', { path: 'nested/deep/file.txt', content: 'one one', create_parents: true });
  await assert.rejects(f.call('workspace_edit', { path: 'nested/deep/file.txt', old_text: 'one', new_text: 'two' }), /found 2/);
  await f.call('workspace_edit', { path: 'nested/deep/file.txt', old_text: 'one', new_text: 'two', replace_all: true });
  assert.equal(await fs.readFile(path.join(f.cwd, 'nested/deep/file.txt'), 'utf8'), 'two two');
  await assert.rejects(f.call('workspace_read', { path: 'absent' }), /ENOENT/);
  await assert.rejects(f.call('workspace_write', { path: '.', content: 'not a directory replacement' }), /regular file/);
  await assert.rejects(f.call('workspace_edit', { path: 'nested/deep/file.txt', old_text: 'missing', new_text: '' }), /found 0/);
});

test('non-regular files are rejected without blocking on a FIFO; invalid UTF8 is not silently rewritten', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), fifo = path.join(f.cwd, 'pipe'); execFileSync('mkfifo', [fifo]);
  await assert.rejects(f.call('workspace_read', { path: fifo }), /regular file/);
  await fs.writeFile(path.join(f.cwd, 'binary'), Buffer.from([0xff, 0x61, 0x62]));
  await assert.rejects(f.call('workspace_edit', { path: 'binary', old_text: 'a', new_text: 'c' }), /valid UTF8/);
  assert.deepEqual(await fs.readFile(path.join(f.cwd, 'binary')), Buffer.from([0xff, 0x61, 0x62]));
});

test('bounded recursive literal search can search outside default cwd and override skip_dirs', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.outside, 'node_modules'));
  await fs.writeFile(path.join(f.outside, 'a.txt'), 'needle A\nneedle B\nnone');
  await fs.writeFile(path.join(f.outside, 'node_modules', 'b.txt'), 'needle C');
  const first = await f.call('workspace_search', { path: f.outside, query: 'needle', limit: 1 });
  assert.equal(first.matches.length, 1); assert.equal(first.next_offset, 1);
  const next = await f.call('workspace_search', { path: f.outside, query: 'needle', offset: 1 }); assert.equal(next.matches.length, 1);
  const all = await f.call('workspace_search', { path: f.outside, query: 'needle', skip_dirs: [] }); assert.equal(all.matches.length, 3);
});

test('configured operator deny patterns apply to reads/writes/real symlink targets/search without builtin jail', async t => {
  const f = await fixture(t), configPath = path.join(f.directory, 'policy.yaml');
  await fs.writeFile(configPath, "agent:\n  tool_deny_patterns:\n    - '(^|/)protected(\\.txt|/|$)'\n");
  const workspace = createWorkspace({ ...f.options, configPath });
  await fs.writeFile(path.join(f.outside, 'protected.txt'), 'needle secret fixture');
  await fs.symlink(path.join(f.outside, 'protected.txt'), path.join(f.cwd, 'ordinary.txt'));
  await assert.rejects(workspace.call('workspace_read', { path: 'ordinary.txt' }), /Operator policy/);
  await assert.rejects(workspace.call('workspace_write', { path: path.join(f.outside, 'protected.txt'), content: 'blocked' }), /Operator policy/);
  const found = await workspace.call('workspace_search', { path: f.outside, query: 'needle' }); assert.equal(found.matches.length, 0);
  await fs.mkdir(path.join(f.outside, 'protected')); await fs.symlink(path.join(f.outside, 'protected'), path.join(f.cwd, 'shortcut'));
  await assert.rejects(workspace.call('workspace_write', { path: 'shortcut/not-created/file.txt', content: 'blocked', create_parents: true }), /Operator policy/);
  await assert.rejects(fs.stat(path.join(f.outside, 'protected/not-created')), /ENOENT/);
});

test('actual shell succeeds, closes stdin, captures stderr/failure, and never interpolates cwd', { timeout: 15_000 }, async t => {
  const f = await fixture(t), strange = path.join(f.outside, "space ; touch INJECTED ' directory"); await fs.mkdir(strange);
  const result = await f.call('workspace_run', { cwd: strange, command: node("process.stdout.write(process.cwd()); process.stderr.write(' STDERR'); process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(' EOF'))"), wait_ms: 5000 });
  assert.equal(result.status, 'succeeded'); assert.match(result.output, /STDERR/); assert.match(result.output, /EOF/); assert.ok(result.output.includes(strange));
  await assert.rejects(fs.stat(path.join(f.outside, 'INJECTED')), /ENOENT/);
  const failure = await f.call('workspace_run', { command: node("process.stderr.write('expected failure');process.exit(7)"), wait_ms: 5000 });
  assert.equal(failure.status, 'failed'); assert.equal(failure.exit_code, 7); assert.match(failure.output, /expected failure/);
  assert.equal((await fs.stat(f.stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.stateDir, failure.job_id, 'state.json'))).mode & 0o777, 0o600);
});

test('durable async job can be recovered by a fresh workspace instance and paged', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const started = await f.call('workspace_run', { command: node("setTimeout(()=>console.log('durable build completed'),800)"), wait_ms: 0, timeout_ms: 5000 });
  assert.ok(['queued', 'running'].includes(started.status));
  const fresh = createWorkspace(f.options), result = await fresh.call('workspace_job', { action: 'wait', job_id: started.job_id, wait_ms: 5000, limit: 7 });
  assert.equal(result.status, 'succeeded'); assert.equal(result.output, 'durable'); assert.equal(result.next_offset, 7);
  const rest = await fresh.call('workspace_job', { action: 'status', job_id: started.job_id, offset: 7 }); assert.match(rest.output, /build completed/);
  assert.ok((await fresh.call('workspace_job', { action: 'list' })).jobs.some(j => j.job_id === started.job_id));
  await assert.rejects(fresh.call('workspace_job', { action: 'status', job_id: '../outside' }), /Invalid job_id/);
  await assert.rejects(fresh.call('workspace_job', { action: 'invalid' }), /Invalid job action/);
});

test('invalid wait parameters never create a job, execute a command, or request cancellation', { timeout: 10_000 }, async t => {
  const f = await fixture(t), sentinel = path.join(f.outside, 'must-not-exist');
  const command = node(`require('fs').writeFileSync(${JSON.stringify(sentinel)},'side effect')`);
  for (const wait_ms of [-1, 20_001, 1.5]) await assert.rejects(f.call('workspace_run', { command, wait_ms }), /integer/);
  assert.deepEqual((await f.call('workspace_job', { action: 'list' })).jobs, []);
  await assert.rejects(fs.stat(sentinel), /ENOENT/);
  const started = await f.call('workspace_run', { command: node("setTimeout(()=>console.log('not cancelled'),700)"), wait_ms: 0, timeout_ms: 5000 });
  await assert.rejects(f.call('workspace_job', { action: 'stop', job_id: started.job_id, wait_ms: -1 }), /integer/);
  await assert.rejects(fs.stat(path.join(f.stateDir, started.job_id, 'stop.json')), /ENOENT/);
  const done = await f.call('workspace_job', { action: 'wait', job_id: started.job_id, wait_ms: 5000 });
  assert.equal(done.status, 'succeeded'); assert.match(done.output, /not cancelled/);
  await assert.rejects(fs.stat(sentinel), /ENOENT/);
});

test('command output storage and returned pages are bounded; jobs time out', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const large = await f.call('workspace_run', { command: node("process.stdout.write('x'.repeat(2*1024*1024))"), wait_ms: 5000 });
  assert.equal(large.status, 'succeeded'); assert.equal(large.captured_output_bytes, 1024 * 1024); assert.equal(large.output.length, 24_000); assert.equal(large.output_truncated, true);
  const timed = await f.call('workspace_run', { command: node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"), timeout_ms: 200, wait_ms: 5000 });
  assert.equal(timed.status, 'timed_out');
});

test('explicit cancellation kills shell descendants including a TERM-ignoring child', { timeout: 15_000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), pidFile = path.join(f.outside, 'child.pid'), childFile = path.join(f.outside, 'child.cjs');
  await fs.writeFile(childFile, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const result = await f.call('workspace_run', { command: `${quote(process.execPath)} ${quote(childFile)}`, wait_ms: 0, timeout_ms: 10_000 });
  for (let i = 0; i < 100; i++) { try { await fs.stat(pidFile); break; } catch { await sleep(30); } }
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  const stopped = await f.call('workspace_job', { action: 'stop', job_id: result.job_id, wait_ms: 5000 }); assert.equal(stopped.status, 'cancelled');
  await sleep(800);
  let state = ''; try { state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  assert.ok(!state || state.startsWith('Z'), `Child still running: ${state}`);
});

test('actual MCP stdio protocol lists tools, executes writes, reports errors, and job survives client disconnect', { timeout: 20_000 }, async t => {
  const f = await fixture(t), require = createRequire(import.meta.url);
  const emptyConfig = path.join(f.directory, 'isolated-mcp-config.yaml'); await fs.writeFile(emptyConfig, 'agent: {}\n');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'); const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const connect = async () => { const client = new Client({ name: 'workspace-test', version: '1' }); const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile, '--cwd', f.cwd, '--state-dir', f.stateDir, '--source-root', source, '--config', emptyConfig], stderr: 'pipe' }); await client.connect(transport); return client; };
  const a = await connect(); t.after(() => a.close());
  const tools = await a.listTools(); assert.equal(tools.tools.length, 8);
  assert.equal(tools.tools.find(tool => tool.name === 'workspace_read').inputSchema.properties.encoding.type, 'string');
  assert.equal(tools.tools.find(tool => tool.name === 'workspace_job').inputSchema.properties.action.type, 'string');
  const written = await a.callTool({ name: 'workspace_write', arguments: { path: path.join(f.outside, 'mcp.txt'), content: 'real MCP write' } }); assert.ok(!written.isError);
  const error = await a.callTool({ name: 'workspace_read', arguments: { path: 'missing' } }); assert.equal(error.isError, true);
  const start = await a.callTool({ name: 'workspace_run', arguments: { command: node("setTimeout(()=>console.log('survived MCP restart'),1200)"), wait_ms: 0, timeout_ms: 5000 } });
  const jobId = JSON.parse(start.content[0].text).job_id; await a.close();
  const b = await connect(); t.after(() => b.close());
  const done = await b.callTool({ name: 'workspace_job', arguments: { action: 'wait', job_id: jobId, wait_ms: 5000 } });
  const result = JSON.parse(done.content[0].text); assert.equal(result.status, 'succeeded'); assert.match(result.output, /survived MCP restart/);
});
