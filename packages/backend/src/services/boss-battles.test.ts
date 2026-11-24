import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createBossBattleStore, type BossDraft } from './boss-battles.js';

const draft: BossDraft = { name: 'The Duvet Wyrm', lore: 'A fitted sheet learned to hiss.', appearance: 'a squat six-legged linen beetle with a pillow-shell and two lantern eyes', kind: 'wyrm', companion: 'Companion A', model: 'fixture/model', moves: [
  { text: 'Put five things in the hamper.', smaller: 'Put one thing in the hamper.' },
  { text: 'Hang one clean jacket.', smaller: 'Put the jacket on a hook.' },
  { text: 'Pull the blanket flat.', smaller: 'Straighten one corner of the blanket.' },
] };

test('generate a private battle, shrink or replace a move, and award XP exactly once across reloads', () => {
  const db = new Database(':memory:');
  try {
    let store = createBossBattleStore(db);
    const id = store.create('I keep putting off laundry.', draft);
    const [battle] = store.list().battles;
    assert.equal(battle.name, 'The Duvet Wyrm');
    assert.equal(battle.moves.length, 3);
    assert.throws(() => store.create('Another active issue', draft), /current battle/);
    assert.throws(() => store.change(id, 'win', undefined, undefined), /Finish a move/);
    const [first, next] = battle.moves;
    store.change(id, 'shrink', first.id, undefined);
    assert.equal(store.list().battles[0].moves[0].text, first.smaller);
    store.change(id, 'swap', next.id, 'Put two shirts away.');
    store.change(id, 'complete', first.id, undefined);
    store = createBossBattleStore(db);
    store.change(id, 'complete', first.id, undefined);
    assert.equal(store.list().xp, 10);
    assert.throws(() => store.change(id, 'swap', first.id, 'Another move'), /no longer/);
    store.change(id, 'pause', undefined, undefined);
    const other = store.create('Write an email reply.', draft);
    assert.throws(() => store.change(id, 'resume', undefined, undefined), /current battle/);
    assert.throws(() => store.change(id, 'complete', next.id, undefined), /no longer/);
    store.change(other, 'remove', undefined, undefined);
    store.change(id, 'resume', undefined, undefined);
    assert.equal(store.list().battles[0].moves[1].text, 'Put two shirts away.');
    store.change(id, 'win', undefined, undefined);
    assert.equal(store.list().battles[0].status, 'won');
    assert.equal(store.list().xp, 10);
    store.change(id, 'remove', undefined, undefined);
    assert.deepEqual(store.list(), { battles: [], xp: 10 });
  } finally { db.close(); }
});

test('requesting a portrait uses only the curated creature description and rejects duplicate or uncertain retries', () => {
  const db = new Database(':memory:');
  try {
    const store = createBossBattleStore(db);
    assert.throws(() => store.create('Dishes', { ...draft, moves: [draft.moves[0], draft.moves[0], draft.moves[0]] }), /three separate/);
    const id = store.create('Dishes. Entirely private fixture 318.', { ...draft, kind: 'slime' });
    let calls = 0;
    const start = (prompt: string) => {
      assert.match(prompt, /squat six-legged linen beetle/);
      assert.doesNotMatch(prompt, /moth-winged serpent/);
      assert.doesNotMatch(prompt, /private fixture|318/);
      return `job-${++calls}`;
    };
    assert.throws(() => store.portrait(id, () => { throw Error('not started'); }), /not started/);
    store.portrait(id, start);
    assert.throws(() => store.portrait(id, start), /already/);
    store.clearFailedPortrait(id, 'unrelated');
    assert.throws(() => store.portrait(id, start), /already/);
    store.clearFailedPortrait(id, 'job-1');
    store.portrait(id, start);
    store.finishPortrait(id, 'test.png');
    assert.throws(() => store.portrait(id, start), /already/);
    assert.equal(calls, 2);
  } finally { db.close(); }
});
