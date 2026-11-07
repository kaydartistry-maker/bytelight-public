// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The reader has to find a real compaction line and, more importantly, must
// not report a row that merely mentions the flag. A transcript is full of our
// own conversation ABOUT compaction — this file's own text would qualify.
//
// It reads only the house's own lanes. Claude Code keeps a project folder for
// every session on this box, and a squash from one of those (the system tmp
// folder, Oct 9 2026) sat on the owner page as though it were one of ours.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyRead, dedupeCopies, forgetStale, heartbeatLanes, isHeartbeatLane, scanLaneTranscripts,
  type CompactionEvent, type FileMark,
} from './compaction-log.js';
import { projectKeyForDir } from './heartbeat/transcript-usage.js';

interface Fixture {
  root: string;
  transcriptRoot: string;
  lanesRoot: string;
  /** Write a transcript into a lane's own project folder; returns its path. */
  write(lane: string, file: string, lines: string[], trailingNewline?: boolean): string;
  done(): void;
}

/** A house with lanes under data/heartbeat and a Claude projects folder beside it. */
function fixture(lanes: string[] = ['primary']): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'bytelight-compaction-'));
  const lanesRoot = join(root, 'data', 'heartbeat');
  const transcriptRoot = join(root, 'projects');
  mkdirSync(transcriptRoot, { recursive: true });
  for (const lane of lanes) mkdirSync(join(lanesRoot, lane, 'io'), { recursive: true });
  return {
    root, transcriptRoot, lanesRoot,
    write(lane, file, lines, trailingNewline = true) {
      const dir = join(transcriptRoot, projectKeyForDir(join(lanesRoot, lane)));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file);
      writeFileSync(path, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
      return path;
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Where each fixture's transcripts were read to, the way the shelf keeps them in the database. */
const fixtureMarks = new WeakMap<Fixture, Map<string, FileMark>>();

/** One full read, the way the shelf takes it: found, marked, copies folded. */
async function readAll(f: Fixture): Promise<CompactionEvent[]> {
  let marks = fixtureMarks.get(f);
  if (!marks) fixtureMarks.set(f, (marks = new Map()));
  const events: CompactionEvent[] = [];
  const held = marks;
  const scan = await scanLaneTranscripts(held, (read) => {
    events.push(...read.events);
    applyRead(held, read);
  }, { transcriptRoot: f.transcriptRoot, lanesRoot: f.lanesRoot });
  forgetStale(held, scan);
  return dedupeCopies(events);
}

const squash = (at: string, body: string) => JSON.stringify({
  type: 'user', isCompactSummary: true, timestamp: at,
  message: { role: 'user', content: body },
});

test('a real compaction line is found, with its stamp, its size and its lane', async () => {
  const f = fixture();
  try {
    f.write('primary', 'abc123.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ordinary turn' } }),
      squash('2026-09-07T02:04:23.924Z', 'This session is being continued. ' + 'x'.repeat(100)),
    ]);
    const events = await readAll(f);
    assert.equal(events.length, 1, 'exactly the compaction line, not the ordinary turn');
    assert.equal(events[0].at, '2026-09-07T02:04:23.924Z');
    assert.equal(events[0].sessionId, 'abc123');
    assert.equal(events[0].lane, 'primary');
    assert.equal(events[0].project, projectKeyForDir(join(f.lanesRoot, 'primary')));
    assert.ok(events[0].chars > 100, 'the size stands in for how much conversation was squashed');
  } finally {
    f.done();
  }
});

test('talking about compaction is not a compaction', async () => {
  const f = fixture();
  try {
    f.write('primary', 'abc123.jsonl', [
      // Us discussing it — the words are here, the flag is false.
      JSON.stringify({ type: 'assistant', isCompactSummary: false, timestamp: '2026-09-07T20:00:00.000Z', message: { role: 'assistant', content: 'isCompactSummary is how the CLI marks it' } }),
      // And a line where the phrase appears only inside the text.
      JSON.stringify({ type: 'user', timestamp: '2026-09-07T20:01:00.000Z', message: { role: 'user', content: 'what does "isCompactSummary":true mean' } }),
    ]);
    assert.deepEqual(await readAll(f), [], 'a mention is not an event');
  } finally {
    f.done();
  }
});

test('only the house lanes are read: not the system tmp folder, not any other Claude project, not a folder with no io', async () => {
  const f = fixture(['primary']);
  try {
    mkdirSync(join(f.lanesRoot, 'half-built'), { recursive: true });
    f.write('primary', 'aaa.jsonl', [squash('2026-10-09T05:00:00.000Z', 'ours')]);
    f.write('half-built', 'bbb.jsonl', [squash('2026-10-09T06:00:00.000Z', 'not a lane yet')]);
    for (const stray of ['-tmp', '-home-someone', '-home-someone-bytelight']) {
      mkdirSync(join(f.transcriptRoot, stray), { recursive: true });
      writeFileSync(join(f.transcriptRoot, stray, 'ccc.jsonl'), squash('2026-10-09T06:27:54.996Z', `from ${stray}`) + '\n', 'utf8');
    }
    const events = await readAll(f);
    assert.deepEqual(events.map((e) => e.summary), ['ours']);
    assert.deepEqual(heartbeatLanes(f.lanesRoot), ['primary'], 'a lane is a folder with an io folder in it');
  } finally {
    f.done();
  }
});

/**
 * Resume copies the whole transcript into a new file under a new id, so every
 * compaction already in it lands on disk again, and the Memory app listed the
 * same compaction over and over — one of them eight times.
 */
test('one squash carried into three resumed copies is one row', async () => {
  const f = fixture();
  try {
    const line = squash('2026-09-17T14:09:47.000Z', 'This session is being continued. ' + 'x'.repeat(200));
    f.write('primary', 'ccc.jsonl', [line]);
    f.write('primary', 'aaa.jsonl', [line]);
    f.write('primary', 'bbb.jsonl', [line]);
    const events = await readAll(f);
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, 'aaa', 'kept deterministically, not by filesystem order');
  } finally {
    f.done();
  }
});

test('two genuinely different squashes in one copied transcript both survive', async () => {
  // The danger of deduping is swallowing a real event. Same file, same lane,
  // different moments.
  const f = fixture();
  try {
    const a = squash('2026-09-17T14:09:47.000Z', 'first ' + 'x'.repeat(200));
    const b = squash('2026-09-19T10:39:35.000Z', 'second ' + 'y'.repeat(200));
    f.write('primary', 'aaa.jsonl', [a, b]);
    f.write('primary', 'bbb.jsonl', [a, b]);
    const events = await readAll(f);
    assert.deepEqual(events.map((e) => e.at).sort(), ['2026-09-17T14:09:47.000Z', '2026-09-19T10:39:35.000Z']);
  } finally {
    f.done();
  }
});

test('the same stamp in two different lanes is two events, never one', async () => {
  const at = '2026-09-17T14:09:47.000Z';
  const f = fixture(['primary', 'second']);
  try {
    for (const lane of ['primary', 'second']) f.write(lane, 'aaa.jsonl', [squash(at, 'the same summary ' + 'x'.repeat(200))]);
    const events = await readAll(f);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.lane).sort(), ['primary', 'second']);
  } finally {
    f.done();
  }
});

test('dedupe keeps order and touches nothing that is already unique', () => {
  const rows = [
    { sessionId: 'a', project: 'p', lane: 'primary', at: '2026-09-19T00:00:00.000Z', chars: 3, summary: 'one' },
    { sessionId: 'b', project: 'p', lane: 'primary', at: '2026-09-18T00:00:00.000Z', chars: 3, summary: 'two' },
  ];
  assert.deepEqual(dedupeCopies(rows), rows);
  assert.equal(dedupeCopies([...rows, { ...rows[0], sessionId: 'z' }]).length, 2);
});

test('a transcript that grows is read from where the last read stopped', async () => {
  const f = fixture();
  try {
    const path = f.write('primary', 'live.jsonl', [squash('2026-10-20T01:00:00.000Z', 'the first squash')]);
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['the first squash']);
    assert.deepEqual(await readAll(f), [], 'nothing new, nothing handed back');

    appendFileSync(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'carrying on' } }) + '\n');
    appendFileSync(path, squash('2026-10-20T09:00:00.000Z', 'the second squash') + '\n');
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['the second squash'], 'only what was added');
  } finally {
    f.done();
  }
});

test('a half-written last line is read again once it is finished', async () => {
  const f = fixture();
  try {
    const whole = squash('2026-10-20T02:00:00.000Z', 'written in two goes');
    const path = f.write('primary', 'live.jsonl', [whole.slice(0, 40)], false);
    assert.deepEqual(await readAll(f), [], 'half a line is not an event yet');
    appendFileSync(path, whole.slice(40) + '\n');
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['written in two goes']);
  } finally {
    f.done();
  }
});

test('a transcript rewritten in place is read again from the top', async () => {
  // Reopening a room trims old copies of the house file out of its transcript,
  // which rewrites the file shorter. A read that carried on from the old place
  // would land in the middle of a line, or past the end.
  const f = fixture();
  try {
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'z'.repeat(5000) } });
    const path = f.write('primary', 'room.jsonl', [filler, squash('2026-10-20T03:00:00.000Z', 'before the trim')]);
    assert.equal((await readAll(f)).length, 1);
    writeFileSync(path, squash('2026-10-20T03:00:00.000Z', 'before the trim') + '\n'
      + squash('2026-10-20T04:00:00.000Z', 'after the trim') + '\n', 'utf8');
    const again = await readAll(f);
    assert.deepEqual(again.map((e) => e.summary).sort(), ['after the trim', 'before the trim'],
      'read whole; the shelf folds the one it already has');
  } finally {
    f.done();
  }
});

test('a transcript rewritten in place that has grown past the old place is still read from the top', async () => {
  // The size alone cannot tell this from a file that only grew: the top of the
  // file is what gives it away.
  const f = fixture();
  try {
    const path = f.write('primary', 'room.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'the old first line' } }),
      squash('2026-10-20T06:00:00.000Z', 'one'),
    ]);
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['one']);
    writeFileSync(path, squash('2026-10-20T07:00:00.000Z', 'two, near the top') + '\n'
      + JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(5000) } }) + '\n', 'utf8');
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['two, near the top']);
  } finally {
    f.done();
  }
});

test('a transcript rewritten in place with its first lines untouched is still read again from the top', async () => {
  // Reopening a room trims old copies of the house file out of its transcript,
  // and the top of the file can come through the trim unchanged. What gives it
  // away then is the bytes just before where the last read stopped.
  const f = fixture();
  try {
    const opening = JSON.stringify({ type: 'system', content: 'o'.repeat(6000) });
    const path = f.write('primary', 'room.jsonl', [
      opening,
      squash('2026-10-20T11:00:00.000Z', 'before the trim'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a'.repeat(3000) } }),
    ]);
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['before the trim']);
    writeFileSync(path, [
      opening,
      squash('2026-10-20T12:00:00.000Z', 'moved up by the trim'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'b'.repeat(20000) } }),
    ].join('\n') + '\n', 'utf8');
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['moved up by the trim']);
  } finally {
    f.done();
  }
});

test('the reader keeps no marks of its own: a read nobody stored is handed over again', async () => {
  // The shelf stores a transcript's mark in the same write as its squashes, so
  // a failed write can never leave a squash marked as read and never stored.
  const f = fixture();
  try {
    f.write('primary', 'aaa.jsonl', [squash('2026-10-20T05:00:00.000Z', 'kept until it lands')]);
    const roots = { transcriptRoot: f.transcriptRoot, lanesRoot: f.lanesRoot };
    const marks = new Map<string, FileMark>();
    const handed: string[] = [];
    await scanLaneTranscripts(marks, (read) => { handed.push(...read.events.map((e) => e.summary)); }, roots);
    await scanLaneTranscripts(marks, (read) => { handed.push(...read.events.map((e) => e.summary)); }, roots);
    assert.deepEqual(handed, ['kept until it lands', 'kept until it lands'], 'not stored, so read again');

    await scanLaneTranscripts(marks, (read) => applyRead(marks, read), roots);
    let again = 0;
    await scanLaneTranscripts(marks, () => { again++; }, roots);
    assert.equal(again, 0, 'stored, and unchanged, so not opened again');
  } finally {
    f.done();
  }
});

test('when the one writing the squashes down fails, the walk stops and nothing after it is marked', async () => {
  const f = fixture();
  try {
    f.write('primary', 'aaa.jsonl', [squash('2026-10-20T05:00:00.000Z', 'first')]);
    f.write('primary', 'bbb.jsonl', [squash('2026-10-20T06:00:00.000Z', 'second')]);
    const roots = { transcriptRoot: f.transcriptRoot, lanesRoot: f.lanesRoot };
    const marks = new Map<string, FileMark>();
    await assert.rejects(scanLaneTranscripts(marks, (read) => {
      if (read.path.endsWith('bbb.jsonl')) throw new Error('the shelf could not write');
      applyRead(marks, read);
    }, roots));
    assert.deepEqual([...marks.keys()].map((p) => p.slice(-9)), ['aaa.jsonl'], 'the first was kept, the failed one was not');
    const later: string[] = [];
    await scanLaneTranscripts(marks, (read) => { later.push(...read.events.map((e) => e.summary)); }, roots);
    assert.deepEqual(later, ['second'], 'the next walk picks up the one that failed, and only that one');
  } finally {
    f.done();
  }
});

test('an unchanged transcript is not opened again: same size and same stamp is skipped on sight', async () => {
  // Proved by changing the bytes and putting the size and stamp back: a reader
  // that opened the file would find the new squash; one that skips it cannot.
  const f = fixture();
  try {
    // A whole-second stamp, so putting it back is exact.
    const stamp = new Date('2026-10-20T08:00:00.000Z');
    const path = f.write('primary', 'room.jsonl', [squash('2026-10-20T08:00:00.000Z', 'AAAA')]);
    utimesSync(path, stamp, stamp);
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['AAAA']);
    const size = statSync(path).size;
    writeFileSync(path, squash('2026-10-20T08:00:00.000Z', 'BBBB') + '\n', 'utf8');
    utimesSync(path, stamp, stamp);
    assert.equal(statSync(path).size, size, 'the same size, so only the bytes differ');
    assert.deepEqual(await readAll(f), [], 'skipped without being opened');
    utimesSync(path, stamp, new Date(stamp.getTime() + 5000));
    assert.deepEqual((await readAll(f)).map((e) => e.summary), ['BBBB'], 'a new stamp gets it read again, from the top');
  } finally {
    f.done();
  }
});

test('a transcript Claude Code deleted is forgotten from the marks, and only in a folder that was read', async () => {
  const f = fixture();
  try {
    const gone = f.write('primary', 'old.jsonl', [squash('2026-10-01T00:00:00.000Z', 'old')]);
    f.write('primary', 'new.jsonl', [squash('2026-10-02T00:00:00.000Z', 'new')]);
    await readAll(f);
    const marks = fixtureMarks.get(f)!;
    marks.set(join(f.root, 'elsewhere', 'x.jsonl'), { size: 1, mtimeMs: 1, offset: 1, headLen: 0, headHash: '', tailLen: 0, tailHash: '' });
    rmSync(gone);
    const scan = await scanLaneTranscripts(marks, () => {}, { transcriptRoot: f.transcriptRoot, lanesRoot: f.lanesRoot });
    assert.deepEqual(scan.stale, [gone]);
  } finally {
    f.done();
  }
});

test('a line far longer than one piece of the read is still read whole', async () => {
  // A transcript is read four megabytes at a time; a squash, or a tool result,
  // can straddle any number of pieces.
  const f = fixture();
  try {
    const long = 'L'.repeat(9 * 1024 * 1024);
    f.write('primary', 'big.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(5 * 1024 * 1024) } }),
      squash('2026-10-20T09:00:00.000Z', long),
      squash('2026-10-20T10:00:00.000Z', 'after the long one'),
    ]);
    const events = await readAll(f);
    assert.deepEqual(events.map((e) => e.chars), [long.length, 'after the long one'.length]);
  } finally {
    f.done();
  }
});

test("only the house's own lanes count as lanes for the compaction banner", () => {
  const root = mkdtempSync(join(tmpdir(), 'bytelight-lanes-'));
  try {
    mkdirSync(join(root, 'data', 'heartbeat', 'primary', 'io'), { recursive: true });
    mkdirSync(join(root, 'data', 'heartbeat', 'half-built'), { recursive: true });
    assert.equal(isHeartbeatLane('primary', root), true);
    assert.equal(isHeartbeatLane('tmp', root), false, 'the Archivist works in the tmp folder and is not a lane');
    assert.equal(isHeartbeatLane('half-built', root), false, 'a lane has an io folder');
    assert.equal(isHeartbeatLane('..', root), false);
    assert.equal(isHeartbeatLane('../heartbeat/primary', root), false);
    assert.equal(isHeartbeatLane('', root), false);
    assert.equal(isHeartbeatLane(undefined, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
