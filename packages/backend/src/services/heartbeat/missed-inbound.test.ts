import test from 'node:test';
import assert from 'node:assert/strict';
import { missedInboundBanner, selectMissedInbound } from './runtime.js';

// The seam this net closes, stated as a test rather than as a rule on a wall.
//
// Catch-up is assembled at the START of a wake, so a message arriving during
// one is already too late for it. Side notes are only written while a turn is
// active and exactly one lane is busy. A message landing between those two
// conditions is stored, stamped delivered, and handed to nobody — which
// happened four times before anyone had a witness for it.
//
// These pin the selection rule the net runs on. The rule is deliberately
// one-way: it may offer a message twice, never zero times.
//
// THIS FILE USED TO HOLD ITS OWN COPY of the filter and test the copy. That is
// why it stayed green through weeks of the misfire below: a check written from
// the same understanding as the code cannot disagree with it. It imports the
// real function now.

interface Msg { role: 'user' | 'companion'; content: string; createdAt: string }

const HISTORY: Msg[] = [
  { role: 'user', content: 'earlier thing', createdAt: '2026-08-13T16:05:00Z' },
  { role: 'companion', content: 'the drop, final', createdAt: '2026-08-13T16:05:30Z' },
  { role: 'user', content: 'can we centre that bubble', createdAt: '2026-08-13T16:14:42Z' },
  { role: 'companion', content: 'we are already upstairs', createdAt: '2026-08-13T16:15:12Z' },
];

const USERS = HISTORY.filter(m => m.role === 'user');
const NEWEST = '2026-08-13T16:14:42Z';

function missed(since: string | undefined, currentPrompt: string, users = USERS, newest = NEWEST): Msg[] {
  return selectMissedInbound(users, since, currentPrompt, newest);
}

test('a message that arrived during a wake is found on the next turn', () => {
  // The wake spoke at 16:15; her 16:14:42 was never handed over.
  const out = missed('2026-08-13T16:05:00Z', 'did you see this?');
  assert.deepEqual(out.map(m => m.content), ['can we centre that bubble']);
});

test('the message arriving right now is not offered back to itself', () => {
  const out = missed('2026-08-13T16:05:00Z', 'can we centre that bubble');
  assert.equal(out.length, 0, 'the prompt is being handed over already');
});

// The misfire. input.prompt is not the bare message — it is a platform frame,
// a withdrawal note and a Codex side-note handover stacked in front of the
// content. Compared for equality, none of those ever match, so the message
// being read at that very moment was announced as one nobody received. Every
// turn in a Discord channel carries a frame, so every one of them lied.
test('a prompt wearing a platform frame still recognises its own message', () => {
  const framed = [
    '=== PLATFORM: DISCORD ===',
    'Responding in #cafe. Max message length: 2000 chars.',
    '',
    '=== MESSAGE ===',
    'can we centre that bubble',
  ].join('\n');
  const out = missed('2026-08-13T16:05:00Z', framed);
  assert.equal(out.length, 0, 'the framed prompt IS this message, not a report that it went missing');
});

test('a withdrawal note in front of the content does not fake a miss either', () => {
  const withNote = '[She removed her last message from the room.]\n\ncan we centre that bubble';
  assert.equal(missed('2026-08-13T16:05:00Z', withNote).length, 0);
});

test('a genuinely different prompt does not swallow the missed one', () => {
  // The exclusion is ENDS WITH, not "contains anywhere" — a message quoted in
  // the middle of a longer prompt is still a message nobody answered.
  const quoted = 'can we centre that bubble\n\nand then she said something else entirely';
  assert.deepEqual(missed('2026-08-13T16:05:00Z', quoted).map(m => m.content), ['can we centre that bubble']);
});

test('an image-only message is recognised by position, not by its empty text', () => {
  // Every string ends with the empty string, so a wordless row can only be
  // identified as the arriving turn by being the newest one.
  const users: Msg[] = [
    { role: 'user', content: 'earlier thing', createdAt: '2026-08-13T16:05:00Z' },
    { role: 'user', content: '', createdAt: '2026-08-13T16:20:00Z' },
  ];
  const arriving = selectMissedInbound(users, '2026-08-13T16:05:00Z', '', '2026-08-13T16:20:00Z');
  assert.equal(arriving.length, 0, 'the wordless row IS the turn arriving now');

  const older = selectMissedInbound(users, '2026-08-13T16:05:00Z', 'a later typed message', '2026-08-13T16:25:00Z');
  assert.deepEqual(older.map(m => m.createdAt), ['2026-08-13T16:20:00Z'], 'an older wordless row is still a miss');
});

test('our own replies are never in it', () => {
  const out = selectMissedInbound(HISTORY as { content: string; createdAt: string }[], undefined, 'anything', NEWEST);
  // selectMissedInbound is handed the user rows only; this pins that contract.
  assert.ok(out.some(m => m.content === 'the drop, final'), 'it filters by nothing but the watermark and the prompt');
});

test('nothing older than the watermark comes back', () => {
  const out = missed('2026-08-13T16:14:42Z', 'did you see this?');
  assert.equal(out.length, 0);
});

test('with no watermark at all it offers everything of hers rather than nothing', () => {
  // A fresh lane has no watermark. Erring toward handing over is the whole
  // design: a doubled answer is visible, a lost one is not.
  const out = missed(undefined, 'unrelated prompt');
  assert.equal(out.length, 2);
});

test('a batch caught at a session birth tells the window to read the replay first', () => {
  const banner = missedInboundBanner(7, true);
  assert.match(banner, /while this lane was restarting/);
  assert.match(banner, /READ THAT FIRST/);
  assert.doesNotMatch(banner, /reached no turn at all/);
});

test('a race on a living lane still says nobody got it', () => {
  const banner = missedInboundBanner(1, false);
  assert.match(banner, /reached no turn at all/);
  assert.doesNotMatch(banner, /restarting/);
  assert.match(banner, /Answer it now/);
});
