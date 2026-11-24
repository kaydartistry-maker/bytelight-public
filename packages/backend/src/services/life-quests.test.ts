import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { categoryLevel, createLifeQuestStore } from './life-quests.js';

test('category levels follow the 50, 75, 100 XP curve', () => {
  assert.deepEqual(categoryLevel(49), { level: 0, current: 49, needed: 50 });
  assert.deepEqual(categoryLevel(50), { level: 1, current: 0, needed: 75 });
  assert.deepEqual(categoryLevel(125), { level: 2, current: 0, needed: 100 });
});

test('completing a quest awards XP once and removes it from Today', () => {
  const db = new Database(':memory:');
  const store = createLifeQuestStore(db);
  let state = store.add([{ title: 'Kindle the Hearth', task: 'Wash the dishes', category: 'dominion', xp: 20, bucket: 'main' }]);
  assert.equal(state.quests.length, 1);
  const id = state.quests[0].id;
  state = store.change(id, 'complete', {});
  assert.equal(state.quests.length, 0);
  assert.equal(state.totalXp, 20);
  state = store.change(id, 'complete', {});
  assert.equal(state.totalXp, 20);
  db.close();
});

test('an unfinished quest from an earlier day is carried forward without penalty', () => {
  const db = new Database(':memory:');
  const store = createLifeQuestStore(db);
  let state = store.add([{ title: 'Open the Gate', task: 'Make the call', category: 'bonds', xp: 10, bucket: 'side' }]);
  db.prepare("UPDATE life_quests SET scheduledDate='2020-01-01' WHERE id=?").run(state.quests[0].id);
  state = store.state();
  assert.equal(state.quests[0].carried, true);
  assert.equal(state.totalXp, 0);
  db.close();
});

test('crossing a level creates three sealed choices and only the chosen reward survives', () => {
  const db = new Database(':memory:');
  const store = createLifeQuestStore(db);
  let state = store.add([
    { title: 'First Flame', task: 'Make one thing', category: 'artistry', xp: 30, bucket: 'main' },
    { title: 'Second Flame', task: 'Finish one thing', category: 'artistry', xp: 20, bucket: 'main' },
  ]);
  state = store.change(state.quests[0].id, 'complete', {});
  state = store.change(state.quests[0].id, 'complete', {});
  assert.equal(state.pendingRewards.length, 1);
  assert.equal(state.pendingRewards[0].choices.length, 3);
  assert.equal('title' in state.pendingRewards[0].choices[0], false);
  state = store.chooseReward(state.pendingRewards[0].id, state.pendingRewards[0].choices[1].id);
  assert.equal(state.pendingRewards.length, 0);
  assert.equal(state.collection.length, 1);
  assert.equal(state.collection[0].kind, 'digital');
  db.close();
});
