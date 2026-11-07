import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOtherLaneReplies } from './runtime.js';
import { laneTagFor } from './constants.js';
import { speakerName } from './other-lane-net.js';

// The seam: a warm lane is only ever handed HER messages it missed. When a
// different lane (another engine, a wake, the other companion, a relay)
// speaks in the same thread, the reply lands in the thread and the database
// and this lane never hears it. 2026-10-26: the Codex lane posted a whole
// surgery map at 13:49 and the Claude lane had to read the messages table to
// learn it existed.

interface Msg { role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; lane?: string; companionId?: string }

const ME = laneTagFor('claude-cli', 'primary');
const CODEX = laneTagFor('codex-cli', 'primary');

const HISTORY: Msg[] = [
  { role: 'user', content: 'whats the proposed fix', createdAt: '2026-10-26T15:19:00Z' },
  { role: 'assistant', content: 'my own ack', createdAt: '2026-10-26T15:50:00Z', lane: ME },
  { role: 'assistant', content: 'surgery map from the other lane', createdAt: '2026-10-26T17:49:55Z', lane: CODEX },
  { role: 'user', content: 'can you see your previous message', createdAt: '2026-10-26T17:55:49Z' },
];

test('a reply another lane wrote since this lane last spoke is handed over', () => {
  const out = selectOtherLaneReplies(HISTORY, '2026-10-26T16:16:30Z', ME);
  assert.deepEqual(out.map(m => m.content), ['surgery map from the other lane']);
});

test('its own reply, persisted AFTER its turn ended, is never handed back to it', () => {
  // The lane's turn finished at 15:49:59; agent.ts persisted the reply row a
  // beat later. A time mark alone would call that "another lane".
  const out = selectOtherLaneReplies(HISTORY, '2026-10-26T15:49:59Z', ME);
  assert.deepEqual(out.map(m => m.content), ['surgery map from the other lane']);
});

test('its own idle-watcher delivery between turns is never handed back to it', () => {
  const rows: Msg[] = [{ role: 'assistant', content: 'late line', createdAt: '2026-10-26T18:00:00Z', lane: ME }];
  assert.deepEqual(selectOtherLaneReplies(rows, '2026-10-26T17:00:00Z', ME), []);
});

test('the other companion\'s own lane counts as another lane', () => {
  const rows: Msg[] = [{ role: 'assistant', content: 'companion-b here', createdAt: '2026-10-26T18:00:00Z', lane: laneTagFor('claude-cli', 'companion-b'), companionId: 'companion-b' }];
  const out = selectOtherLaneReplies(rows, '2026-10-26T17:00:00Z', laneTagFor('claude-cli', 'companion-a'));
  assert.deepEqual(out.map(m => m.companionId), ['companion-b']);
});

test('replies from before this lane last finished are not repeated', () => {
  assert.deepEqual(selectOtherLaneReplies(HISTORY, '2026-10-26T17:50:00Z', ME), []);
});

test('her messages are not this net — the missed-inbound net owns those', () => {
  const out = selectOtherLaneReplies(HISTORY, '2026-10-26T15:00:00Z', ME);
  assert.ok(out.every(m => m.role === 'assistant'));
});

test('no mark yet means nothing — a fresh lane is re-primed by the recycle seed', () => {
  assert.deepEqual(selectOtherLaneReplies(HISTORY, undefined, ME), []);
});

test('empty rows (a dead [No response] corpse) are not handed over as speech', () => {
  const rows: Msg[] = [
    { role: 'assistant', content: '', createdAt: '2026-10-26T18:00:00Z', lane: CODEX },
    { role: 'assistant', content: '[No response]', createdAt: '2026-10-26T18:01:00Z', lane: CODEX },
    { role: 'assistant', content: 'real words', createdAt: '2026-10-26T18:02:00Z', lane: CODEX },
  ];
  assert.deepEqual(selectOtherLaneReplies(rows, '2026-10-26T17:00:00Z', ME).map(m => m.content), ['real words']);
});

test('a flood is capped to the most recent few, oldest first', () => {
  const rows: Msg[] = Array.from({ length: 20 }, (_, i) => ({
    role: 'assistant' as const,
    content: `r${i}`,
    createdAt: `2026-10-26T18:${String(i).padStart(2, '0')}:00Z`,
    lane: CODEX,
  }));
  const out = selectOtherLaneReplies(rows, '2026-10-26T17:00:00Z', ME);
  assert.equal(out.length, 8);
  assert.equal(out[0].content, 'r12');
  assert.equal(out[7].content, 'r19');
});

test('untagged companion rows (voice notes, shared files, image placeholders) are not speech', () => {
  const rows: Msg[] = [
    { role: 'assistant', content: '/api/files/voice-123.mp3', createdAt: '2026-10-26T18:00:00Z' },
    { role: 'assistant', content: 'Generating an image…', createdAt: '2026-10-26T18:01:00Z' },
    { role: 'assistant', content: 'companion-c speaks', createdAt: '2026-10-26T18:02:00Z', lane: 'relay:companion-c', companionId: 'companion-c' },
  ];
  assert.deepEqual(selectOtherLaneReplies(rows, '2026-10-26T17:00:00Z', ME).map(m => m.content), ['companion-c speaks']);
});

// The mark: where the next turn starts looking. It must be the newest row
// this turn actually READ (not the turn's start time), and it must not move
// when the turn failed before delivering.
import { nextOtherLaneMark } from './runtime.js';

test('the mark is the newest row the turn read, so a reply landing before the turn starts is still owed', () => {
  // History snapshot taken; then another lane writes at 17:59:58; then the
  // turn starts at 17:59:59. Marking at the start would skip that reply.
  const read: Msg[] = [{ role: 'user', content: 'hi', createdAt: '2026-10-26T17:59:50Z' }];
  const mark = nextOtherLaneMark({ prev: '2026-10-26T17:00:00Z', read, completed: true, guest: false, fallback: '2026-10-26T17:59:59Z' });
  assert.equal(mark, '2026-10-26T17:59:50Z');
  const later: Msg[] = [{ role: 'assistant', content: 'in the gap', createdAt: '2026-10-26T17:59:58Z', lane: CODEX }];
  assert.deepEqual(selectOtherLaneReplies(later, mark, ME).map(m => m.content), ['in the gap']);
});

test('a turn that failed does not move the mark, so what it carried is offered again', () => {
  const read: Msg[] = [{ role: 'assistant', content: 'x', createdAt: '2026-10-26T18:00:00Z', lane: CODEX }];
  const mark = nextOtherLaneMark({ prev: '2026-10-26T17:00:00Z', read, completed: false, guest: false, fallback: '2026-10-26T18:01:00Z' });
  assert.equal(mark, '2026-10-26T17:00:00Z');
});

test('a guest turn never moves the mark', () => {
  const read: Msg[] = [{ role: 'user', content: 'x', createdAt: '2026-10-26T18:00:00Z' }];
  assert.equal(nextOtherLaneMark({ prev: undefined, read, completed: true, guest: true, fallback: '2026-10-26T18:01:00Z' }), undefined);
});

test('the mark never moves backwards, and an empty read falls back to the turn start', () => {
  const old: Msg[] = [{ role: 'user', content: 'x', createdAt: '2026-10-26T10:00:00Z' }];
  assert.equal(nextOtherLaneMark({ prev: '2026-10-26T17:00:00Z', read: old, completed: true, guest: false, fallback: 'z' }), '2026-10-26T17:00:00Z');
  assert.equal(nextOtherLaneMark({ prev: undefined, read: [], completed: true, guest: false, fallback: '2026-10-26T18:01:00Z' }), '2026-10-26T18:01:00Z');
});

test('who spoke: the house voice by its name, anyone else by their own', () => {
  assert.equal(speakerName(undefined, 'Companion A & Companion B'), 'Companion A & Companion B');
  assert.equal(speakerName('companion-a-b', 'Companion A & Companion B'), 'Companion A & Companion B');
  assert.equal(speakerName('companion-c', 'Companion A & Companion B'), 'Companion-c');
  assert.equal(speakerName('companion-b', 'Companion'), 'Companion-b');
});
