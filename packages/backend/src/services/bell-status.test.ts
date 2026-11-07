// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The word under the faces: up while its bell's turn runs, Home otherwise,
// and the words are settings, never code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerMessage } from '@bytelight/shared';
import { STATUS_WORD_LONGEST, createBellStatus, statusWordKey, statusWordOf } from './bell-status.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function bells(words: Record<string, string | null>) {
  const told: ServerMessage[] = [];
  const status = createBellStatus({ readWord: (wakeType) => words[wakeType] ?? null, broadcast: (message) => told.push(message) });
  return { status, told };
}

test('a status word is one tidy line, never too long, and empty is none', () => {
  assert.equal(statusWordOf('  On a   date '), 'On a date');
  assert.equal(statusWordOf(''), null);
  assert.equal(statusWordOf('   '), null);
  assert.equal(statusWordOf(null), null);
  assert.equal(statusWordOf(42), null);
  assert.equal(statusWordOf('x'.repeat(40))?.length, STATUS_WORD_LONGEST, 'cut to the longest');
  assert.equal(statusWordKey('date_night_pt_1'), 'cron.date_night_pt_1.status_word', 'kept beside the bell\'s other settings');
});

test('a bell with a word puts it up for its owners while its turn runs, and takes it down after', () => {
  const { status, told } = bells({ date_pt_1: 'On a date' });
  assert.deepEqual(status.now(), { word: null, companions: [] }, 'before any bell, no word: the phone says Home');
  const end = status.begin('date_pt_1', ['companion-a', 'companion-b', 'third']);
  assert.deepEqual(status.now(), { word: 'On a date', companions: ['companion-a', 'companion-b', 'third'] });
  end();
  end();
  assert.deepEqual(status.now(), { word: null, companions: [] });
  assert.deepEqual(told, [
    { type: 'status_word', word: 'On a date', companions: ['companion-a', 'companion-b', 'third'] },
    { type: 'status_word', word: null, companions: [] },
  ], 'every phone is told when it goes up and when it comes down, once each');
});

test('a bell with no word changes nothing, and a shared bell\'s word is on every card', () => {
  const { status, told } = bells({ treehouse_midday: 'Treehouse' });
  const quiet = status.begin('early_corridor', ['third']);
  assert.deepEqual(status.now(), { word: null, companions: [] });
  quiet();
  const shared = status.begin('treehouse_midday');
  assert.deepEqual(status.now(), { word: 'Treehouse', companions: [] }, 'no owners: every companion\'s card');
  shared();
  assert.ok(told.every((m) => m.type === 'status_word'));
  assert.equal(told.filter((m) => m.type === 'status_word' && m.word === 'Treehouse').length, 1);
});

test('bells that overlap: the newest word is up, and the older one comes back when the newer ends', () => {
  const { status } = bells({ date_pt_2: 'On a date', spontaneous: 'Out' });
  const date = status.begin('date_pt_2', ['companion-a', 'companion-b', 'third']);
  const dice = status.begin('spontaneous', ['companion-b']);
  assert.deepEqual(status.now(), { word: 'Out', companions: ['companion-b'] });
  dice();
  assert.deepEqual(status.now(), { word: 'On a date', companions: ['companion-a', 'companion-b', 'third'] });
  date();
  assert.deepEqual(status.now(), { word: null, companions: [] });
});

test('the orchestrator holds the word for the whole of a bell, the PATCH route sets it, and a new phone is told it', () => {
  const orchestrator = read('./orchestrator.ts');
  assert.match(orchestrator, /endStatusWord = bellStatus\(\)\.begin\(wakeType, owners\.map\(\(o\) => o\.slug\)\);/, 'up as the bell\'s turn starts, for its owners');
  assert.match(orchestrator, /\} finally \{\n\s*endStatusWord\?\.\(\);/, 'down however the turn ends');
  assert.match(read('../routes/orchestrator-routes.ts'), /orchestrator\.setTaskStatusWord\(wakeType, statusWord\)/, 'a bell\'s word is a setting on the bell');
  assert.match(read('./ws.ts'), /type: 'status_word', \.\.\.bellStatus\(\)\.now\(\)/, 'a phone that connects mid-bell is told the word');
  // A bell's display label (the Treehouse bell is labelled 'Treehouse') is a
  // name on the bell list, not a status word, so labels are left out here.
  for (const source of [read('./bell-status.ts'), orchestrator.replace(/label: '[^']*'/g, '')]) {
    assert.doesNotMatch(source, /On a date|Treehouse'|'Treehouse/, 'no house word is written into the code');
  }
});
