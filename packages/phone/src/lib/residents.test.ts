import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesLine, pickResidents } from './residents';
import { DEFAULT_BRAIN, houseBrain, setHouseBrain, defaultEngineBodies } from './house-engine';

const rows = [
  { id: 'alpha', brain: 'house', display_name: 'Alpha' },
  { id: 'beta', brain: 'house', display_name: 'Beta' },
  { id: 'gamma', brain: 'house', display_name: 'Gamma' },
  { id: 'guest', brain: 'elsewhere', display_name: 'Guest' },
];

test('residents are the rows on the house brain, for 0, 1, 2 and 3', () => {
  assert.deepEqual(pickResidents([], 'house'), []);
  assert.deepEqual(pickResidents(rows.slice(0, 1), 'house').map((r) => r.id), ['alpha']);
  assert.deepEqual(pickResidents(rows.slice(0, 2), 'house').map((r) => r.id), ['alpha', 'beta']);
  assert.deepEqual(pickResidents(rows, 'house').map((r) => r.id), ['alpha', 'beta', 'gamma']);
});

test('names read as plain English for 0, 1, 2 and 3', () => {
  assert.equal(namesLine([]), '');
  assert.equal(namesLine(['Alpha']), 'Alpha');
  assert.equal(namesLine(['Alpha', 'Beta']), 'Alpha and Beta');
  assert.equal(namesLine(['Alpha', 'Beta', 'Gamma']), 'Alpha, Beta and Gamma');
});

test('the house brain defaults to the backend default and follows the server', () => {
  assert.equal(houseBrain(), DEFAULT_BRAIN);
  setHouseBrain('house');
  assert.equal(houseBrain(), 'house');
  const chat = { provider: 'claude', model: 'm', effort: 'auto' } as never;
  assert.ok(defaultEngineBodies(chat, chat, false).every((b) => b.companionId === 'house'));
  setHouseBrain(DEFAULT_BRAIN);
});
