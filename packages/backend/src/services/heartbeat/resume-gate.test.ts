/**
 * When a lane may reopen its room, read from the decision itself.
 *
 * Regression cases from review:
 *  - a fresh room that never got a turn (so never got its re-prime) must not be
 *    reopened, or the prime is skipped for good and the marks it inherits are
 *    another room's;
 *  - a cap, login or refused-model backoff ends a room that was never at fault,
 *    so the relaunch after it reopens that room;
 *  - an orphaned CLI that will not die keeps the next launch off the transcript;
 *  - a parked (sleeping) room wakes as a new one, whatever door was armed;
 *  - the exit handler arms .fresh only when the next launch builds new.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HeartbeatSession, shouldResumeLaunch, waitForPidExit } from './supervisor.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

function lane(name: string, marksRoom?: string): HeartbeatSession {
  const probe = new HeartbeatSession(name);
  rmSync(probe.dir, { recursive: true, force: true });
  mkdirSync(join(probe.dir, 'io'), { recursive: true });
  writeFileSync(join(probe.dir, 'io', '.session-id'), ID);
  writeFileSync(join(probe.dir, 'io', '.room-id'), ID);
  if (marksRoom) writeFileSync(join(probe.dir, 'io', '.marks-room'), marksRoom);
  // A new instance hydrates the ids the files above hold, as a restart would.
  const s = new HeartbeatSession(name);
  (s as any).reaped = true;
  return s;
}
const willResume = (s: HeartbeatSession): boolean => (s as any).nextLaunchWillResume();

test('a room that never had a turn handed to it is not reopened', () => {
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID, roomHasSpoken: false }), false);
  const s = lane('test-gate-unspoken');
  try { assert.equal(willResume(s), false, 'no .marks-room at all'); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a room whose marks name a different room is not reopened', () => {
  const s = lane('test-gate-other-room', OTHER);
  try { assert.equal(willResume(s), false); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a room that has had a turn is reopened after a restart', () => {
  const s = lane('test-gate-spoken', ID);
  try { assert.equal(willResume(s), true); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('an orphan that would not die keeps the launch off the transcript', () => {
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID, orphanAlive: true }), false);
  const s = lane('test-gate-orphan', ID);
  try {
    (s as any).orphanAlive = true;
    assert.equal(willResume(s), false);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('waiting for an orphan is bounded, and a dead one is seen as dead', async () => {
  let polls = 0;
  assert.equal(await waitForPidExit(1, () => ++polls < 3, 1_000, 1), true);
  const t0 = Date.now();
  assert.equal(await waitForPidExit(1, () => true, 50, 5), false);
  assert.ok(Date.now() - t0 < 1_000, 'gives up at the bound');
});

test('waiting for an orphan never blocks the event loop', async () => {
  let fired = false;
  setTimeout(() => { fired = true; }, 5);
  const gone = await waitForPidExit(1, () => true, 120, 10);
  assert.equal(gone, false);
  assert.equal(fired, true, 'a timer due during the wait ran during the wait');
});

test('the first ensure() with a live orphan holds the turn until the orphan is gone, then launches', async () => {
  const { spawn } = await import('child_process');
  const s = lane('test-gate-orphan-async', ID);
  (s as any).reaped = false;
  const orphan = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeFileSync(join(s.dir, 'io', '.child.pid'), String(orphan.pid));
  let launched = 0;
  (s as any).launch = () => { launched++; };
  try {
    const held = s.ensure('model-a');
    assert.equal(held, true, 'the caller waits for the relaunch before appending to the inbox');
    assert.equal(launched, 0, 'nothing launches onto the transcript while the orphan may be alive');
    const deadline = Date.now() + 6_000;
    while (launched === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(launched, 1, 'launches once the orphan is confirmed gone');
    assert.equal((s as any).orphanAlive, false);
  } finally {
    try { orphan.kill('SIGKILL'); } catch { /* gone */ }
    rmSync(s.dir, { recursive: true, force: true });
  }
});

function exitAfterResume(s: HeartbeatSession, flag: 'capSeen' | 'authSeen' | 'modelRejectedSeen'): void {
  Object.assign(s as any, { launchedResumed: true, launchedAt: Date.now(), [flag]: true, launchedModel: 'm', model: 'm' });
  (s as any).handleExit(1);
}

for (const flag of ['capSeen', 'authSeen', 'modelRejectedSeen'] as const) {
  test(`a ${flag.replace('Seen', '')} backoff after a resumed launch reopens the room afterwards`, () => {
    const s = lane(`test-gate-backoff-${flag}`, ID);
    (s as any).firstLaunchOfProcess = false;
    try {
      exitAfterResume(s, flag);
      assert.equal((s as any).sessionId, ID, 'the id is kept');
      assert.equal(willResume(s), true, 'and the relaunch after the backoff reopens it');
      assert.equal(existsSync(join(s.dir, 'io', '.fresh')), false, 'so no re-prime is armed');
    } finally { s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
  });
}

test('a parked room wakes as a new one even after a watchdog door was armed', () => {
  const s = lane('test-gate-sleep', ID);
  (s as any).firstLaunchOfProcess = false;
  try {
    (s as any).watchdogRecycle = true;
    writeFileSync(join(s.dir, 'io', '.sleeping'), String(Date.now()));
    (s as any).handleExit(0);
    assert.equal((s as any).watchdogRecycle, false);
    assert.equal(willResume(s), false);
  } finally { s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('the exit handler arms .fresh only for a launch that builds new', () => {
  const reopening = lane('test-gate-gap-reopen', ID);
  (reopening as any).firstLaunchOfProcess = false;
  const rebuilding = lane('test-gate-gap-new', ID);
  (rebuilding as any).firstLaunchOfProcess = false;
  try {
    writeFileSync(join(reopening.dir, 'io', '.fresh'), '');
    (reopening as any).watchdogRecycle = true;
    Object.assign(reopening as any, { launchedAt: Date.now() - 600_000 });
    (reopening as any).handleExit(null);
    assert.equal(existsSync(join(reopening.dir, 'io', '.fresh')), false,
      'a turn landing in the relaunch gap must not prime a room that is about to reopen');

    Object.assign(rebuilding as any, { launchedAt: Date.now() - 600_000 });
    (rebuilding as any).handleExit(null);
    assert.equal(existsSync(join(rebuilding.dir, 'io', '.fresh')), true, 'a room built new is still primed');
  } finally {
    reopening.stop(); rebuilding.stop();
    rmSync(reopening.dir, { recursive: true, force: true });
    rmSync(rebuilding.dir, { recursive: true, force: true });
  }
});

// ─── A fresh room is never handed a line built without its prime ─────

import { appendFileSync, readFileSync } from 'fs';

function inbox(s: HeartbeatSession, rows: Array<{ turn: string; primed: boolean }>): void {
  for (const r of rows) appendFileSync(s.inboxPath, JSON.stringify({ content: 'hi', ...r }) + '\n');
}

test('a fresh launch sets aside unread unprimed lines that a turn is waiting to re-send', () => {
  const s = lane('test-gate-aside');
  try {
    inbox(s, [{ turn: 't1', primed: false }]);
    s.registerWaitingTurn('t1');
    (s as any).setAsideUnprimedBacklog(42);
    const size = s.inboxSize();
    assert.equal(s.inboxOffset(), size, 'the new room will not read it unprimed');
    assert.deepEqual(s.skippedBacklog(), { generation: 42, from: 0, to: size });
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a line nobody is waiting on is never set aside (it would be lost, not re-sent)', () => {
  const s = lane('test-gate-aside-orphan');
  try {
    inbox(s, [{ turn: 't1', primed: false }]);
    (s as any).setAsideUnprimedBacklog(42);
    assert.equal(s.inboxOffset(), 0);
    assert.equal(s.skippedBacklog(), null);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a backlog that is already primed is left for the new room to read', () => {
  const s = lane('test-gate-aside-primed');
  try {
    inbox(s, [{ turn: 't1', primed: true }]);
    s.registerWaitingTurn('t1');
    (s as any).setAsideUnprimedBacklog(42);
    assert.equal(s.inboxOffset(), 0);
    assert.equal(existsSync(join(s.dir, 'io', '.skipped-backlog')), false);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

// ─── One decision per relaunch ───────────────────────────────────────

test('the decision made at exit is the one the relaunch uses, whatever changes in the gap', () => {
  const s = lane('test-gate-carry', ID);
  (s as any).firstLaunchOfProcess = false;
  try {
    (s as any).watchdogRecycle = true;
    Object.assign(s as any, { launchedAt: Date.now() - 600_000, launchedResumed: false });
    (s as any).handleExit(null);
    assert.equal(existsSync(join(s.dir, 'io', '.fresh')), false, 'decided: reopen, so no prime armed');
    // Something moves in the two-second gap.
    writeFileSync(join(s.dir, 'io', '.marks-room'), OTHER);
    assert.equal((s as any).takeLaunchDecision(), true, 'the launch keeps the decision .fresh was set from');
    assert.equal((s as any).takeLaunchDecision(), false, 'and it is spent: a later launch decides afresh');
  } finally { s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('a turn in the relaunch gap sees the room that is coming, not the dead child', () => {
  const s = lane('test-gate-gap-view', ID);
  (s as any).firstLaunchOfProcess = false;
  try {
    (s as any).watchdogRecycle = true;
    Object.assign(s as any, { launchedAt: Date.now() - 600_000, launchedResumed: false });
    (s as any).handleExit(null);
    assert.equal(s.status, 'starting');
    assert.equal(s.resumedLaunch, true, 'the coming room is a reopened one');
  } finally { s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
});

// ─── A set-aside line survives the backend dying before the re-send ───

function setAsideOnDisk(name: string, rows: Array<Record<string, unknown>>, resent: boolean) {
  const probe = new HeartbeatSession(name);
  rmSync(probe.dir, { recursive: true, force: true });
  mkdirSync(join(probe.dir, 'io'), { recursive: true });
  for (const r of rows) appendFileSync(probe.inboxPath, JSON.stringify({ content: 'hi', ...r }) + '\n');
  const to = probe.inboxSize();
  writeFileSync(join(probe.dir, 'io', '.inbox-offset'), String(to));
  writeFileSync(join(probe.dir, 'io', '.skipped-backlog'), JSON.stringify({ generation: 7, from: 0, to }));
  writeFileSync(join(probe.dir, 'io', '.last-handed-user'), '2026-11-11T10:00:00.000Z');
  if (resent) appendFileSync(probe.inboxPath, JSON.stringify({ content: 'hi again', turn: 't1', primed: true }) + '\n');
  return probe.dir;
}
const readMark = (dir: string) => { try { return readFileSync(join(dir, 'io', '.last-handed-user'), 'utf8').trim(); } catch { return null; } };

test('a set-aside never re-sent (the backend died first) gives her message back to the net', () => {
  const dir = setAsideOnDisk('test-gate-aside-crash', [
    { turn: 't1', primed: false, handed_before: '2026-11-11T09:30:00.000Z' },
    { turn: 't2', primed: false, handed_before: '2026-11-11T09:00:00.000Z' },
  ], false);
  try {
    new HeartbeatSession('test-gate-aside-crash');
    assert.equal(readMark(dir), '2026-11-11T09:00:00.000Z', 'rewound to before the earliest set-aside turn');
    assert.equal(existsSync(join(dir, 'io', '.skipped-backlog')), false, 'the record is settled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a set-aside line with no earlier mark makes the mark unknown, which hands everything', () => {
  const dir = setAsideOnDisk('test-gate-aside-crash-nomark', [{ turn: 't1', primed: false, handed_before: null }], false);
  try {
    new HeartbeatSession('test-gate-aside-crash-nomark');
    assert.equal(readMark(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a set-aside that was re-sent leaves the mark alone', () => {
  const dir = setAsideOnDisk('test-gate-aside-resent', [{ turn: 't1', primed: false, handed_before: '2026-11-11T09:00:00.000Z' }], true);
  try {
    new HeartbeatSession('test-gate-aside-resent');
    assert.equal(readMark(dir), '2026-11-11T10:00:00.000Z');
    assert.equal(existsSync(join(dir, 'io', '.skipped-backlog')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a set-aside record whose offset never moved is discarded without rewinding (the line is still unread)', () => {
  const dir = setAsideOnDisk('test-gate-aside-unmoved', [{ turn: 't1', primed: false, handed_before: '2026-11-11T09:00:00.000Z' }], false);
  try {
    writeFileSync(join(dir, 'io', '.inbox-offset'), '0');
    new HeartbeatSession('test-gate-aside-unmoved');
    assert.equal(readMark(dir), '2026-11-11T10:00:00.000Z', 'the room will read it; no second answer');
    assert.equal(existsSync(join(dir, 'io', '.skipped-backlog')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
