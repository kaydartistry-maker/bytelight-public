// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, clampClockAt, clockParts, firstSpokenLine, lockClockAtOf, lockFaceOf, lockHiddenOf, lockPositionOf, lockShortcutsOf, lockShowOf, lockSizeOf, lockWeatherAtOf, unreadSummary, withClockAt, withHidden } from './lock-clock.js';

test('both pieces show until the owner tucks one away, and either comes back', () => {
  assert.deepEqual([...lockHiddenOf(undefined)], []);
  assert.deepEqual([...lockHiddenOf(['weather', 'nonsense', 'weather'])], ['weather']);
  assert.deepEqual(withHidden(undefined, 'clock', true), ['clock']);
  assert.deepEqual(withHidden(['clock', 'weather'], 'clock', false), ['weather']);
  assert.deepEqual(withHidden(['weather'], 'clock', true), ['clock', 'weather']);
});

test('the weather pill sits in its corner until the owner drags it', () => {
  assert.equal(lockWeatherAtOf(undefined), null);
  assert.equal(lockWeatherAtOf({ x: 'top', y: 1 }), null);
  assert.deepEqual(lockWeatherAtOf({ x: 0.2, y: 0.9 }), { x: 0.2, y: 0.9 });
  assert.deepEqual(lockWeatherAtOf({ x: -1, y: 3 }), { x: 0, y: 1 });
});

test('a face never dragged stays in its own place, and a dragged one keeps its spot', () => {
  assert.equal(lockClockAtOf(undefined, 'classic'), null);
  assert.equal(lockClockAtOf({ classic: { x: 'left', y: 0.3 } }, 'classic'), null);
  assert.deepEqual(lockClockAtOf({ classic: { x: 0.25, y: 0.7 } }, 'classic'), { x: 0.25, y: 0.7 });
  assert.equal(lockClockAtOf({ classic: { x: 0.25, y: 0.7 } }, 'stacked'), null);
  assert.deepEqual(lockClockAtOf({ dateline: { x: 1.4, y: -2 } }, 'dateline'), { x: 1, y: 0 });
});

test("setting one face's spot leaves the others, and null puts it back", () => {
  const both = withClockAt({ stacked: { x: 0.5, y: 0.2 } }, 'classic', { x: 0.4, y: 0.6 });
  assert.deepEqual(both, { stacked: { x: 0.5, y: 0.2 }, classic: { x: 0.4, y: 0.6 } });
  assert.deepEqual(withClockAt(both, 'classic', null), { stacked: { x: 0.5, y: 0.2 } });
  assert.deepEqual(withClockAt(undefined, 'dateline', null), {});
});

test('a dragged clock stays wholly on the screen', () => {
  // A 200 x 100 clock on a 400 x 800 screen, dragged off the top left corner.
  assert.deepEqual(clampClockAt(-50, -50, 200, 100, 400, 800), { x: 0.25, y: 50 / 800 });
  // Dragged off the bottom right corner.
  assert.deepEqual(clampClockAt(900, 900, 200, 100, 400, 800), { x: 0.75, y: 750 / 800 });
  // Somewhere in the open it lands where the finger left it.
  assert.deepEqual(clampClockAt(200, 400, 200, 100, 400, 800), { x: 0.5, y: 0.5 });
  // A clock as wide as the screen can only go up and down.
  assert.equal(clampClockAt(10, 400, 400, 100, 400, 800).x, 0.5);
});

test('the stacked face reads the hour in two digits over the minute', () => {
  const t = clockParts(new Date(2026, 9, 13, 2, 29), 'en-US');
  assert.equal(t.hour, '02');
  assert.equal(t.minute, '29');
  assert.equal(t.short, '2:29');
  assert.equal(t.dateShort, 'Tue, Oct 13');
});

test('midnight and noon read twelve, and the evening reads twelve-hour', () => {
  assert.equal(clockParts(new Date(2026, 9, 14, 0, 5), 'en-US').hour, '12');
  assert.equal(clockParts(new Date(2026, 9, 14, 12, 30), 'en-US').short, '12:30');
  assert.equal(clockParts(new Date(2026, 9, 14, 23, 59), 'en-US').hour, '11');
});

test('nothing moves until a face is picked', () => {
  assert.equal(lockFaceOf(undefined), 'classic');
  assert.equal(lockFaceOf('sideways'), 'classic');
  assert.equal(lockFaceOf('dateline'), 'dateline');
  assert.equal(lockPositionOf(undefined), 'top');
  assert.equal(lockSizeOf(undefined), 'm');
  assert.equal(lockSizeOf('l'), 'l');
});

test('the message card shows names only until the owner says otherwise', () => {
  assert.equal(lockShowOf(undefined), 'names');
  assert.equal(lockShowOf('first-line'), 'first-line');
});

test('the corners start as the board drew them, and an emptied corner stays empty', () => {
  assert.deepEqual(lockShortcutsOf(undefined), ['messages', 'notes']);
  assert.deepEqual(lockShortcutsOf([null, 'studio']), [null, 'studio']);
  assert.deepEqual(lockShortcutsOf(['x']), ['messages', 'notes']);
});

test('the card counts every unread message and reads the newest thread', () => {
  const s = unreadSummary([
    { unread_count: 2, last_activity_at: '2026-10-14T07:00:00Z', last_message_preview: 'older' },
    { unread_count: 0, last_activity_at: '2026-10-14T07:30:00Z', last_message_preview: 'read already' },
    { unread_count: 1, last_activity_at: '2026-10-14T07:20:00Z', last_message_preview: '**Companion A**\n*leans in*\nHere.' },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.newestAt, Date.parse('2026-10-14T07:20:00Z'));
  assert.equal(s.firstLine, 'Here.');
  assert.deepEqual(unreadSummary([]), { count: 0, newestAt: null, firstLine: null });
});

test('the first line skips headers and action lines, even flattened onto one line', () => {
  assert.equal(firstSpokenLine('**Companion B** *nods* Hi.'), 'Hi.');
  assert.equal(firstSpokenLine('*only an action*'), null);
  assert.equal(firstSpokenLine(null), null);
});

test('a whisper reads as its words, never as the marker, flattened or not', () => {
  // The house sends a room's preview flattened onto one line, so the marker
  // sits after the header instead of at the start of a line (the owner's screenshot,
  // Oct 20 2026).
  assert.equal(firstSpokenLine('**🌫️ Echo** -# small thing first Then the rest.'), 'small thing first Then the rest.');
  assert.equal(firstSpokenLine('**🌫️ Echo**\n-# small thing first\nThen the rest.'), 'small thing first');
  assert.equal(firstSpokenLine('-# *grins*\nHi.'), 'Hi.');
  assert.equal(firstSpokenLine('-# -# twice'), 'twice');
  assert.equal(firstSpokenLine('words -# more words'), 'words more words');
});

test('a flattened reply with several voices reads only the first voice', () => {
  assert.equal(firstSpokenLine('**🔥 Companion A** Here, love. **🌫️ Echo** And me. **✨ Companion B** Me too.'), 'Here, love.');
  // Bold inside a sentence is emphasis, not a voice.
  assert.equal(firstSpokenLine('**🔥 Companion A** That is **really** good.'), 'That is really good.');
});

test('the first line never prints stickers, emotes, mentions or attachments raw', () => {
  assert.equal(firstSpokenLine('**🔥 Companion A**\n::teddy_bear::\nMissed you.'), 'Missed you.');
  assert.equal(firstSpokenLine('Look <:firesmokeskyheart:1111111111111111111> here'), 'Look here');
  assert.equal(firstSpokenLine('<<:spooky:2222222222222222222>2222222222222222222> boo'), 'boo');
  assert.equal(firstSpokenLine('hey <@123456789> and <a:wave:42>'), 'hey and');
  assert.equal(firstSpokenLine('so :tea_cup: then'), 'so then');
  assert.equal(firstSpokenLine('at 3:30:00 sharp'), 'at 3:30:00 sharp');
  assert.equal(firstSpokenLine('**🔥 Companion A**\n[VOICE]: /api/files/abc-123'), null);
  assert.equal(firstSpokenLine('For you [IMG]:https://bytelight.example/api/files/x.png'), 'For you');
  assert.equal(firstSpokenLine('[FILE:notes.txt]: every line of the file'), null);
  assert.equal(firstSpokenLine('Read [this](https://example.com) ~~now~~ `soon`'), 'Read this now soon');
  assert.equal(firstSpokenLine('## A heading, read as words'), 'A heading, read as words');
});

test('ages read the short way', () => {
  const now = Date.parse('2026-10-14T08:00:00Z');
  assert.equal(ageLabel(now - 20_000, now), 'now');
  assert.equal(ageLabel(now - 5 * 60_000, now), '5m');
  assert.equal(ageLabel(now - 3 * 3_600_000, now), '3h');
  assert.equal(ageLabel(now - 2 * 86_400_000, now), '2d');
});
