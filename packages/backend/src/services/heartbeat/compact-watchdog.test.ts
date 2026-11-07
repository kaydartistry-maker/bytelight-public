// The guard against the real watchdog, with short leashes and a stand-in claude:
// a squash outlives the short leash, a squash that dies is still killed at the
// long one, and the dead squash does not buy the next child the long leash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Read once at import, so they are set before the supervisor loads.
process.env.HEARTBEAT_WATCHDOG_TIMEOUT = '1';
process.env.HEARTBEAT_WATCHDOG_WORKING_TIMEOUT = '5';
const { PROJECT_ROOT } = await import('../../config.js');
const { HeartbeatSession } = await import('./supervisor.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(50); }
  return check();
}

function lane(name: string) {
  const bin = mkdtempSync(join(tmpdir(), 'bytelight-fake-claude-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec sleep 60\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const key = `compact-watchdog-${name}-${process.pid}`;
  const dir = join(PROJECT_ROOT, 'data', 'heartbeat', key);
  const session = new HeartbeatSession(key);
  session.ensure('claude-test-model');
  const pid = (session as any).child.pid as number;
  return {
    session, dir, pid,
    squash: () => spawnSync(process.execPath, [join(dir, 'hooks', 'activity.cjs'), 'pre', 'compact'], { input: '{}' }),
    async done() {
      while (!existsSync(join(dir, 'session.log'))) await sleep(5);
      session.stop();
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('without a squash marked, a quiet idle lane is killed on the short leash', async () => {
  const l = lane('control');
  try {
    assert.ok(await until(() => !alive(l.pid), 4500), 'gone within a poll or two of one second');
  } finally { await l.done(); }
});

test('a squash outlives the short leash, and a squash that dies is still killed at the long one', async () => {
  const l = lane('dead-squash');
  try {
    assert.equal(l.squash().status, 0);
    const started = Date.now();
    await sleep(3500);
    assert.ok(alive(l.pid), 'past the short leash, still squashing');
    assert.ok(await until(() => !alive(l.pid), 6000), 'no post ever came, and the lane was killed anyway');
    assert.ok(Date.now() - started >= 4500, 'on the long leash, not the short one');

    // The next child inherits a log that still ends on the dead squash. It was
    // never that child's work, so it gets no long leash for it.
    assert.ok(await until(() => (session(l).child?.pid ?? l.pid) !== l.pid, 8000), 'a new child came up');
    assert.equal(l.session.toolInFlight(), false);
  } finally { await l.done(); }
});

const session = (l: { session: unknown }) => l.session as { child: { pid: number } | null };
