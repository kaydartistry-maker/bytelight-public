// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * A turn whose room went out from under it stops, instead of staring.
 *
 * Seen from the phone before anybody looked at a log: the tool calls
 * finished, and the turn just sat there until it timed out.
 *
 * A mid-turn relaunch hands the session now running its LAUNCH PROMPT rather
 * than her message, and that prompt tells it in as many words to wait silently
 * and not write to the outbox until a real turn_id arrives. So the turn was
 * waiting for a line from a room under written instruction not to write one.
 *
 * The second test is the one that matters most and it is not about speed: a
 * replaced room must NOT count toward the mute-zombie heuristic. Counting it
 * answers a crash by recycling the room that replaced it.
 *
 * Adapted to this house: the runtime takes its session from the supervisor's
 * map, so the stand-in is put there with __setHeartbeatSessionForTests, and a
 * turn's input is this house's AgentTurnInput.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRuntimeEvent } from '../runtimes/types.js';

process.env.HEARTBEAT_REPLY_TIMEOUT = '1';
process.env.CLAUDE_CLI_HEARTBEAT_ENABLED = 'true';
const { InteractiveCliRuntime, __resetLaneStateForTests } = await import('./runtime.js');
const { __setHeartbeatSessionForTests, shutdownAllHeartbeats } = await import('./supervisor.js');

interface InboxLine { turn: string }
const ROOT = join(tmpdir(), `hb-replaced-test-${process.pid}`);

class Session {
  status = 'running' as const;
  lastError = '';
  dir: string;
  imagesDir: string;
  missedInboundPath: string;
  orphanedRepliesPath = '';
  onIncident: ((text: string) => void) | null = null;
  turnActive = false;
  turnStartedAt = 0;
  turnThreadId: string | null = null;
  currentSessionId: string | null = null;
  resumedLaunch = false;
  lines: string[] = [];
  inbox: InboxLine[] = [];
  restartCalls = 0;
  /** Reads of the generation. The runtime captures it once before the loop, so
   *  flipping from the second read on is a room replaced the instant polling
   *  began — deterministic, no timers. */
  reads = 0;
  replaced = false;
  constructor(name: string) {
    this.dir = join(ROOT, name);
    mkdirSync(join(this.dir, 'io'), { recursive: true });
    this.imagesDir = join(this.dir, 'io', 'images');
    this.missedInboundPath = join(this.dir, 'io', 'missed-inbound.jsonl');
  }
  get launchGeneration(): number {
    this.reads++;
    return this.replaced && this.reads > 1 ? 2 : 1;
  }
  ensure() { return false; }
  async waitForRelaunch() { return true; }
  sideNotesSize() { return 0; }
  sideNotesReadMark() { return ''; }
  readSideNotesFrom() { return { notes: [], newOffset: 0 }; }
  consumeFreshFlag() { const f = this.freshArmed; this.freshArmed = false; return f; }
  outboxSize() { return this.lines.length; }
  activitySize() { return 0; }
  readActivityFrom() { return { lines: [], newOffset: 0 }; }
  busyMtime() { return 0; }
  clearBusy() {}
  requestRestart() { this.restartCalls++; }
  stop() {}
  /** A running room's hook reads a line as soon as it lands, unless a test
   *  says the room dies before it can. */
  autoRead = true;
  appendInbox(line: InboxLine) {
    this.inbox.push(line);
    this.inboxBytes += JSON.stringify(line).length + 1;
    if (this.autoRead && this.status === 'running') this.offset = this.inboxBytes;
  }
  /** The inbox the hook reads: its size, and how far a room has read it. */
  inboxBytes = 0;
  offset = 0;
  aside: { generation: number; from: number; to: number } | null = null;
  freshArmed = false;
  inboxSize() { return this.inboxBytes; }
  inboxOffset() { return this.offset; }
  skippedBacklog() { return this.aside; }
  registerWaitingTurn() {}
  unregisterWaitingTurn() {}
  readOutboxFrom(offset: number) { return { lines: this.lines.slice(offset), newOffset: this.lines.length }; }
}

after(() => {
  __resetLaneStateForTests();
  shutdownAllHeartbeats();
  rmSync(ROOT, { recursive: true, force: true });
});

function turnInput(key: string) {
  return {
    thread: { id: `thread-${key}` },
    tier: 'primary',
    modelRef: { provider: 'claude-cli', model: 'claude-test' },
    platform: 'internal',
    isAutonomous: true,
    orientation: '[full manual] TOOL DOCS AND SKILLS',
    orientationLean: '[lean] live state only',
    systemPrompt: '',
    messages: [
      { role: 'assistant', content: 'earlier reply in this thread', createdAt: '2026-11-11T09:00:00.000Z' },
      { role: 'user', content: 'wake', createdAt: new Date().toISOString() },
    ],
  } as any;
}

async function collect(key: string, session: Session): Promise<AgentRuntimeEvent[]> {
  __setHeartbeatSessionForTests(key, session as any);
  const runtime = new InteractiveCliRuntime({ sessionKey: key });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.runTurn(turnInput(key))) events.push(event);
  return events;
}
const lastError = (events: AgentRuntimeEvent[]) =>
  [...events].reverse().find((e: any) => e.type === 'error') as any;

test('a room replaced mid-turn ends the turn and says so', async () => {
  const session = new Session('replaced');
  session.replaced = true;
  const err = lastError(await collect('replaced', session));
  assert.match(err?.message ?? '', /replaced while this turn was open/);
  assert.match(err.message, /launch prompt rather than this message/);
});

test('and it is not counted as a mute zombie — the new room is not recycled for the old one dying', async () => {
  const session = new Session('replaced-twice');
  session.replaced = true;
  // Two in a row. Under the plain silent path this is exactly what trips the
  // recycle; a replaced room must never reach it.
  session.reads = 0; await collect('replaced-twice', session);
  session.reads = 0; await collect('replaced-twice', session);
  assert.equal(session.restartCalls, 0);
});

test('a room that did NOT change still takes the ordinary timeout path', async () => {
  const session = new Session('not-replaced');
  const err = lastError(await collect('not-replaced', session));
  assert.match(err?.message ?? '', /heartbeat reply timeout/);
});

test('two ordinary silent turns DO trip the recycle — the control that proves the test discriminates', async () => {
  const session = new Session('zombie');
  await collect('zombie', session);
  await collect('zombie', session);
  assert.equal(session.restartCalls, 1);
});

// ─── Review regressions ─────────────────────────────────────────────

test('a turn that began while the lane was between rooms is answered by the room that launches', async () => {
  // Status 'starting': a relaunch is pending. The message waits in the inbox
  // and the room about to launch reads it, so that first relaunch is not a
  // replacement. Ending the turn there rewound the mark and the message was
  // answered twice (once by the room, once again as MISSED).
  const session = new Session('between-rooms') as any;
  session.status = 'starting';
  session.replaced = true;
  const realRead = session.readOutboxFrom.bind(session);
  session.readOutboxFrom = (offset: number) => {
    if (session.reads > 2 && session.lines.length === 0 && session.inbox[0]) {
      session.status = 'running';
      session.lines.push(JSON.stringify({ turn_id: session.inbox[0].turn, content: 'answered by the new room' }));
    }
    return realRead(offset);
  };
  const events = await collect('between-rooms', session);
  const said = events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.text).join('');
  assert.equal(said, 'answered by the new room');
  assert.equal(lastError(events), undefined);
});

test('a turn that never handed its message over does not claim the marks for the room', async () => {
  // .marks-room is what the supervisor reads to decide a room may be reopened.
  // A turn that failed before the inbox (here ensure() throws) handed nothing,
  // so it must not claim the room has spoken.
  const { existsSync } = await import('node:fs');
  const session = new Session('never-handed') as any;
  session.currentSessionId = 'room-never-handed';
  session.ensure = () => { throw new Error('no launch'); };
  await collect('never-handed', session);
  assert.equal(existsSync(join(session.dir, 'io', '.marks-room')), false);

  const spoke = new Session('handed') as any;
  spoke.currentSessionId = 'room-handed';
  await collect('handed', spoke);
  assert.equal(existsSync(join(spoke.dir, 'io', '.marks-room')), true, 'a turn that was handed over does claim it');
});

// ─── Second review: a line no room read is never lost or answered unprimed ──

import { readFileSync, existsSync as fileExists } from 'node:fs';

/** A stand-in where the room that is running when the turn starts dies before
 *  reading the line, and a new room launches. `fresh` picks which kind. */
function deadAtTheDoor(name: string, freshRoom: boolean) {
  const session = new Session(name) as any;
  session.autoRead = false;
  let gen = 1;
  let polls = 0;
  session.currentSessionId = 'room-old';
  Object.defineProperty(session, 'launchGeneration', { get: () => gen });
  const realRead = session.readOutboxFrom.bind(session);
  session.readOutboxFrom = (offset: number) => {
    // The turn-start sweep reads too, before any line exists; count only the
    // polls of a turn that has handed its line over.
    if (session.inbox.length > 0) polls++;
    if (polls === 1) {
      // The old room died unread; the relaunch comes up.
      gen = 2;
      session.currentSessionId = 'room-new';
      if (freshRoom) {
        session.freshArmed = true;
        session.aside = { generation: 2, from: 0, to: session.inboxBytes };
        session.offset = session.inboxBytes; // set aside, not read
      }
    } else if (session.lines.length === 0 && session.inbox.length >= (freshRoom ? 2 : 1)) {
      session.offset = session.inboxBytes; // the new room reads what it was given
      session.lines.push(JSON.stringify({ turn_id: session.inbox[0].turn, content: 'answered by the new room' }));
    }
    return realRead(offset);
  };
  return session;
}

test('a resume that dies at the door before reading: the fresh room gets the line again, primed', async () => {
  const session = deadAtTheDoor('dead-door-fresh', true);
  const events = await collect('dead-door-fresh', session);
  assert.equal(lastError(events), undefined, 'not reported as replaced');
  const said = events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.text).join('');
  assert.equal(said, 'answered by the new room');
  assert.equal(session.inbox.length, 2, 'handed over a second time');
  assert.equal((session.inbox[1] as any).turn, (session.inbox[0] as any).turn, 'under the same turn id');
  assert.equal((session.inbox[1] as any).primed, true);
  assert.match((session.inbox[1] as any).content, /Session recycled/, 'with the re-prime this time');
  assert.equal(session.freshArmed, false, 'and the prime flag is spent, so the next turn does not prime again');
  assert.equal(readFileSync(join(session.dir, 'io', '.marks-room'), 'utf8').trim(), 'room-new');
});

test('a relaunch into a reopened room before reading: the turn keeps waiting for that room', async () => {
  const session = deadAtTheDoor('dead-door-resumed', false);
  const events = await collect('dead-door-resumed', session);
  assert.equal(lastError(events), undefined);
  assert.equal(session.inbox.length, 1, 'the unread line is still there for it; not sent twice');
  assert.equal(readFileSync(join(session.dir, 'io', '.marks-room'), 'utf8').trim(), 'room-new');
});

test('a room that read the line and died: the turn ends, and only that room is claimed', async () => {
  const session = new Session('read-then-died') as any;
  session.autoRead = false;
  let gen = 1;
  session.currentSessionId = 'room-read';
  Object.defineProperty(session, 'launchGeneration', { get: () => gen });
  const realRead = session.readOutboxFrom.bind(session);
  session.readOutboxFrom = (offset: number) => {
    if (session.inbox.length > 0) {
      session.offset = session.inboxBytes; // read it
      gen = 2;                             // then the relaunch
      session.currentSessionId = 'room-never-primed';
    }
    return realRead(offset);
  };
  const events = await collect('read-then-died', session);
  assert.match(lastError(events)?.message ?? '', /replaced while this turn was open/);
  assert.equal(readFileSync(join(session.dir, 'io', '.marks-room'), 'utf8').trim(), 'room-read',
    'the new room never got a turn and must not be stamped as spoken');
  assert.equal(fileExists(join(session.dir, 'io', '.marks-room')), true);
});

// ─── Third review: a re-sent line is a whole fresh turn, primed once per room ──

const { __getLaneStateForTests } = await import('./runtime.js');

for (const [name, path] of [['stale-id-door', 'a stale id at the door'], ['restart-unread', 'a restart flag with her line unread']] as const) {
  test(`${path}: the line re-sent to the fresh room carries the full manual`, async () => {
    const session = deadAtTheDoor(`manual-${name}`, true);
    // A warm lane that already had the manual: this turn was built lean.
    __setHeartbeatSessionForTests(`manual-${name}`, session);
    const { __bindLaneForTests } = await import('./runtime.js');
    __bindLaneForTests(`manual-${name}`, `thread-manual-${name}`).manualDelivered = true;
    await collect(`manual-${name}`, session);
    assert.match((session.inbox[0] as any).content, /\[lean\]/, 'built lean for the warm room');
    assert.match((session.inbox[1] as any).content, /\[full manual\]/, 'the fresh room gets the whole manual');
    assert.equal(__getLaneStateForTests(`manual-${name}`)?.manualDelivered, true);
  });
}

test('the history re-prime goes to a fresh room once, not once per re-sent line', async () => {
  const session = deadAtTheDoor('prime-once', true);
  await collect('prime-once', session);
  assert.equal(((session.inbox[1] as any).content.match(/Session recycled/g) ?? []).length, 1);

  // A second turn in the same room has its line set aside too (same fresh
  // generation): that room already holds the history.
  const before = session.inbox.length;
  session.lines = [];
  const realRead = session.readOutboxFrom;
  let armed = false;
  session.readOutboxFrom = (offset: number) => {
    if (!armed && session.inbox.length === before + 1) {
      armed = true;
      session.aside = { generation: 2, from: session.offset, to: session.inboxBytes };
      session.offset = session.inboxBytes;
    } else if (armed && session.inbox.length === before + 2 && session.lines.length === 0) {
      session.offset = session.inboxBytes;
      session.lines.push(JSON.stringify({ turn_id: session.inbox[before].turn, content: 'second answer' }));
    }
    return session.lines.length ? { lines: session.lines.slice(offset), newOffset: session.lines.length } : realRead(offset);
  };
  await collect('prime-once', session);
  assert.equal(session.inbox.length, before + 2, 'the second line was re-sent');
  assert.doesNotMatch((session.inbox[before + 1] as any).content, /Session recycled/, 'no second copy of the history');
});

test('every inbox line carries where the handover mark stood before its turn', async () => {
  const session = new Session('handed-before') as any;
  await collect('handed-before', session);
  assert.equal('handed_before' in (session.inbox[0] as any), true);
});
