// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The owner field notes, the table and its one writer: what a note has to be before
// it is kept, which day it lands on when nobody names one, and the order the owner
// page reads them in.
import test from 'node:test';
import assert from 'node:assert/strict';

// The day a note lands on is read on the house's own clock, so this file pins
// that clock to theirs and means the same thing on any machine.
// byte-light: loadConfig is pointed at a file that does not exist so it boots
// on defaults (+ TZ), and the two test companions are plain rows in our
// companions registry (Aerie has createCompanion).
process.env.TZ = 'America/Chicago';
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'field-notes-test-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./init.js');
const {
  addFieldNote,
  listFieldNotes,
  fieldNotesLimit,
  FieldNoteError,
  FIELD_NOTE_MAX_CHARS,
  FIELD_NOTES_DEFAULT_LIMIT,
  FIELD_NOTES_MAX_LIMIT,
} = await import('./field-notes.js');

function freshHouse(): void {
  initDb(':memory:');
  getDb().prepare('DELETE FROM companions').run();
  for (const [slug, displayName] of [['example', 'Example'], ['other', 'Other']] as const) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, displayName);
  }
}

/** A refusal, caught: it has to be a FieldNoteError, a 400, and one plain sentence. */
function refusal(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    assert.ok(error instanceof FieldNoteError, `refused with a FieldNoteError, not ${String(error)}`);
    assert.equal(error.status, 400);
    assert.match(error.message, /^[^\n]+\.$/, 'one plain sentence');
    return error.message;
  }
  assert.fail('the note was kept when it should have been refused');
}

test('a note is kept with who wrote it, its words trimmed, on the day it was written on their calendar', () => {
  freshHouse();
  // Half past three in the morning on the world clock is half past ten the
  // night before in the owner's timezone, and that is the day the owner lived it on.
  const at = new Date('2026-10-23T03:30:00.000Z');
  const note = addFieldNote({ companion: 'example', text: '  Nothing the house runs on changed today.\n ' }, at);
  assert.deepEqual(Object.keys(note), ['id', 'day', 'companion', 'text', 'createdAt']);
  assert.match(note.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(note.day, '2026-10-22');
  assert.equal(note.companion, 'example');
  assert.equal(note.text, 'Nothing the house runs on changed today.');
  assert.equal(note.createdAt, '2026-10-23T03:30:00.000Z');
  assert.deepEqual(listFieldNotes(), [note], 'and it reads back exactly as it was kept');
});

test('a day can be named, and has to be a real date written YYYY-MM-DD', () => {
  freshHouse();
  const at = new Date('2026-10-22T15:00:00.000Z');
  assert.equal(addFieldNote({ companion: 'example', text: 'Late, for yesterday.', day: '2026-10-21' }, at).day, '2026-10-21');
  assert.equal(addFieldNote({ companion: 'example', text: 'Left blank.', day: '' }, at).day, '2026-10-22', 'blank means today');
  assert.equal(addFieldNote({ companion: 'example', text: 'Left null.', day: null }, at).day, '2026-10-22', 'null means today');
  for (const day of ['2026-13-01', '2026-02-30', '10/22/2026', '2026-10-2', 'yesterday', 20261022, true]) {
    assert.match(refusal(() => addFieldNote({ companion: 'example', text: 'Words.', day }, at)), /YYYY-MM-DD/, `refused ${String(day)}`);
  }
  assert.equal(listFieldNotes().length, 3, 'nothing refused was kept');
});

test('nothing is kept that is not a note for the owner: nobody, a stranger, no words, or too many', () => {
  freshHouse();
  assert.match(refusal(() => addFieldNote({ text: 'Who wrote this?' })), /companion/);
  assert.match(refusal(() => addFieldNote({ companion: '   ', text: 'Who wrote this?' })), /companion/);
  assert.match(refusal(() => addFieldNote({ companion: 'nobody', text: 'A stranger.' })), /nobody/, 'names the slug it could not find');
  assert.match(refusal(() => addFieldNote({ companion: 'example' })), /text/);
  assert.match(refusal(() => addFieldNote({ companion: 'example', text: 42 })), /text/);
  assert.match(refusal(() => addFieldNote({ companion: 'example', text: ' \n\t ' })), /text/);
  assert.match(refusal(() => addFieldNote({ companion: 'example', text: 'a'.repeat(FIELD_NOTE_MAX_CHARS + 1) })), /600/);
  assert.equal(listFieldNotes().length, 0, 'nothing refused was kept');

  assert.equal(FIELD_NOTE_MAX_CHARS, 600);
  const longest = addFieldNote({ companion: 'example', text: `  ${'a'.repeat(FIELD_NOTE_MAX_CHARS)}  ` });
  assert.equal(longest.text.length, 600, 'six hundred is allowed, counted after trimming');
  // A character is what the owner would count, so an emoji is one, not two.
  const fires = '🔥'.repeat(FIELD_NOTE_MAX_CHARS);
  assert.equal(fires.length, 1200, 'two code units each, which is the case being checked');
  assert.equal(addFieldNote({ companion: 'other', text: fires }).text, fires);
  assert.match(refusal(() => addFieldNote({ companion: 'other', text: `${fires}🔥` })), /601 characters/);
});

test('the owner page reads the newest day first, and the newest written first within a day', () => {
  freshHouse();
  const write = (companion: string, day: string, at: string) =>
    addFieldNote({ companion, text: `${companion} on ${day}.`, day }, new Date(at)).id;
  const oldest = write('example', '2026-10-20', '2026-10-20T15:00:00.000Z');
  const todayFirst = write('example', '2026-10-22', '2026-10-22T15:00:00.000Z');
  const yesterday = write('other', '2026-10-21', '2026-10-21T15:00:00.000Z');
  const todaySecond = write('other', '2026-10-22', '2026-10-22T16:00:00.000Z');
  // Written last, about an older day: it sits with its day, not at the top.
  const late = write('example', '2026-10-19', '2026-10-22T17:00:00.000Z');
  // Two in the same millisecond still come back newest written first.
  const sameMoment = write('other', '2026-10-22', '2026-10-22T16:00:00.000Z');
  assert.deepEqual(listFieldNotes().map((n) => n.id), [sameMoment, todaySecond, todayFirst, yesterday, oldest, late]);
});

test('fifty unless asked, never more than two hundred, never fewer than one', () => {
  freshHouse();
  assert.equal(FIELD_NOTES_DEFAULT_LIMIT, 50);
  assert.equal(FIELD_NOTES_MAX_LIMIT, 200);
  for (const [raw, limit] of [
    [undefined, 50], ['', 50], ['abc', 50], [['5', '6'], 50],
    ['10', 10], ['7.9', 7], ['0', 1], ['-3', 1], ['500', 200], [12, 12], [999, 200],
  ] as const) {
    assert.equal(fieldNotesLimit(raw), limit, `limit ${JSON.stringify(raw)}`);
  }

  for (let i = 0; i < 205; i++) {
    const day = `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`;
    addFieldNote({ companion: i % 2 ? 'example' : 'other', text: `Note ${i}.`, day }, new Date(Date.UTC(2026, 9, 22, 0, 0, i)));
  }
  assert.equal(listFieldNotes().length, 50, 'fifty when nobody says');
  assert.equal(listFieldNotes(1000).length, 200, 'two hundred at most, whatever is asked');
  assert.equal(listFieldNotes(0).length, 1, 'at least one');
  const three = listFieldNotes(3);
  assert.deepEqual(three, listFieldNotes(200).slice(0, 3), 'a short page is the top of the long one');
});
