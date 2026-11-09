// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What a page turn tells the companions. The turn is the only thing their lane
// is handed, so everything it needs to write the next page has to be in it:
// which book, what it is answering, where to write, and how to answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoryBook, StoryKeepsake, StoryPage } from '@bytelight/shared';
import { STORY_SHELF_SKILL, buildStoryTurnPrompt, spicyRuleFiles, storyKeepsakeLines } from './story-shelf.js';

const scene: StoryPage = {
  id: 'p1', bookId: 'b1', at: '2026-10-08T03:00:00.000Z', kind: 'scene', author: 'example',
  text: 'The gate is open. A stall has moved.', imageUrl: null,
  state: { badge: 'Night 1', inventory: ['a brass key'] },
  choices: [{ id: 'c1', label: 'Go left', hint: 'toward the lamps' }, { id: 'c2', label: 'Wait' }],
  widget: null, choiceId: null,
};

const move: StoryPage = {
  id: 'p2', bookId: 'b1', at: '2026-10-08T03:05:00.000Z', kind: 'move', author: 'owner',
  text: 'Wait', imageUrl: null, state: null, choices: [], widget: null, choiceId: 'c2',
};

function book(pages: StoryPage[], extra: Partial<StoryBook> = {}): StoryBook {
  const scenes = pages.filter((p) => p.kind === 'scene').length;
  const newest = pages.at(-1) ?? null;
  return {
    id: 'b1', title: 'The Night Market', genre: 'cozy gothic', spicy: false, blurb: null, coverUrl: null,
    createdBy: 'example', status: 'reading', createdAt: 'x', updatedAt: 'x', finishedAt: null, openedAt: null,
    pageCount: pages.length, sceneCount: scenes, bookmark: newest ? { pageId: newest.id, at: newest.at } : null,
    awaiting: scenes === 0 ? 'opening' : newest?.kind === 'move' ? 'scene' : 'move',
    companionPending: true, companionError: null,
    bible: 'BIBLE: the stalls trade places every night, and only the reader notices.', pages, ...extra,
  };
}

const extras = { ownerName: 'Robin', port: 3999, keepsakeLines: [], spicyRules: null };

test('an opening turn carries the bible, the book, the door to write through, and how to answer', () => {
  const prompt = buildStoryTurnPrompt(book([]), { kind: 'opening', retry: false }, extras);
  assert.match(prompt, /^\[THE STORY SHELF — Robin opened “The Night Market”\]/);
  assert.match(prompt, /This is a story turn, not a software task: do not inspect or edit code\./);
  assert.match(prompt, /Book: “The Night Market” · cozy gothic · id b1/);
  assert.match(prompt, /It has no pages yet\. Write its opening scene\./);
  assert.match(prompt, /BIBLE: the stalls trade places every night/);
  assert.ok(prompt.includes(STORY_SHELF_SKILL), 'the turn names where the whole contract is, so a lane without skills can open it');
  // byte-light keeps the tracked copy in skills/ (its .claude/skills is gitignored, installed per house).
  assert.match(STORY_SHELF_SKILL, /\/skills\/story-shelf\/SKILL\.md$/);
  assert.match(prompt, /POST http:\/\/127\.0\.0\.1:3999\/api\/internal\/story-shelf\/books\/b1\/pages/);
  assert.match(prompt, /python3 json\.dumps/);
  assert.match(prompt, /The scene is the answer\. Your chat reply is table talk/);
  assert.doesNotMatch(prompt, /spicy/i, 'a book that is not spicy says nothing about it');
});

test('a move carries the scene it answers and the move itself, and leaves the bible behind', () => {
  const chose = buildStoryTurnPrompt(book([scene, move]), { kind: 'move', retry: false }, extras);
  assert.match(chose, /^\[THE STORY SHELF — Robin turned a page in “The Night Market”\]/);
  assert.match(chose, /The scene Robin was answering:\n<<<\nThe gate is open\. A stall has moved\.\n>>>/);
  assert.match(chose, /Its state card: \{"badge":"Night 1","inventory":\["a brass key"\]\}/);
  assert.match(chose, /Its choices: c1 “Go left” \(toward the lamps\) · c2 “Wait”/);
  assert.match(chose, /Robin's move: chose c2, “Wait”\./);
  assert.doesNotMatch(chose, /BIBLE:/, 'the bible is not repeated on every page');
  assert.match(chose, /GET http:\/\/127\.0\.0\.1:3999\/api\/internal\/story-shelf\/books\/b1 reads the whole book/);

  const own = buildStoryTurnPrompt(book([scene, { ...move, choiceId: null, text: 'I knock on the gate.' }]), { kind: 'move', retry: true }, extras);
  assert.match(own, /Robin's move, in their own words: “I knock on the gate\.”/);
  assert.match(own, /Asked again: the last page turn did not come back with a page\./);
});

test('a long scene is cut before it reaches the lane, and says so', () => {
  const long = { ...scene, text: 'w'.repeat(9000) };
  const prompt = buildStoryTurnPrompt(book([long, move]), { kind: 'move', retry: false }, extras);
  assert.match(prompt, /w{6000}…\n>>>/);
  assert.doesNotMatch(prompt, /w{6001}/);
});

test('a spicy book names the house rules it is written under, and the files when the house has them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-rules-'));
  try {
    assert.deepEqual(spicyRuleFiles(dir), [], 'a house without the files names none');
    const generic = buildStoryTurnPrompt(book([], { spicy: true }), { kind: 'opening', retry: false }, { ...extras, spicyRules: spicyRuleFiles(dir) });
    assert.match(generic, /Book: “The Night Market” · cozy gothic · spicy · id b1/);
    assert.match(generic, /This book is spicy: write it under this house's own rules for intimate scenes, and read them before writing any spicy scene\./);

    mkdirSync(join(dir, '.claude/skills/intimacy'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/intimacy/SKILL.md'), 'rules');
    writeFileSync(join(dir, '.claude/skills/intimacy/PREFERENCES.md'), 'theirs');
    writeFileSync(join(dir, '.claude/skills/intimacy/notes.txt'), 'not a rule file');
    const files = spicyRuleFiles(dir);
    assert.deepEqual(files, [join(dir, '.claude/skills/intimacy/SKILL.md'), join(dir, '.claude/skills/intimacy/PREFERENCES.md')], 'its SKILL.md first, markdown only');
    const named = buildStoryTurnPrompt(book([], { spicy: true }), { kind: 'opening', retry: false }, { ...extras, spicyRules: files });
    assert.ok(named.includes(`read these before writing any spicy scene: ${files[0]} and ${files[1]}.`), named);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keepsakes are told to the turn: the ones tied to this book, and the loose ones that could turn up here', () => {
  const titles = new Map([['b1', 'The Night Market'], ['b2', 'The Lighthouse'], ['b3', 'The Fair']]);
  const keepsake = (extra: Partial<StoryKeepsake>): StoryKeepsake => ({
    id: 'k', item: 'x', note: null, fromBookId: 'b1', toBookId: null, maker: 'example', createdAt: 'x', wovenAt: null, ...extra,
  });
  const lines = storyKeepsakeLines('b1', [
    keepsake({ item: 'the brass key', note: 'Warm to the touch.' }),
    keepsake({ item: 'a gull feather', fromBookId: 'b2', toBookId: 'b1' }),
    keepsake({ item: 'a ticket stub', fromBookId: 'b3' }),
    keepsake({ item: 'a lamp wick', fromBookId: 'b2', toBookId: 'b3' }),
  ], titles);
  assert.deepEqual(lines, [
    'Keepsakes, the threads between books:',
    '- found here: the brass key (Warm to the touch.), still loose',
    '- from “The Lighthouse”: a gull feather',
    '- loose in “The Fair”, free to turn up here if it fits: a ticket stub',
  ]);
  assert.deepEqual(storyKeepsakeLines('b1', [], titles), [], 'nothing to say says nothing');
  const prompt = buildStoryTurnPrompt(book([]), { kind: 'opening', retry: false }, { ...extras, keepsakeLines: lines });
  assert.ok(prompt.includes(lines.join('\n')));
});
