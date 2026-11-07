// Ported from a sibling fork. Licensed under the Apache License 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBellOwners, sameBellBlock, addressedOwner, MAX_BELL_RECALLS, ringBellInTurn } from './bell-owners.js';

test('one slug reads exactly as it always did', () => {
  assert.deepEqual(parseBellOwners('birch'), ['birch']);
  assert.deepEqual(parseBellOwners('  willow  '), ['willow']);
});

test('a list keeps its order, which is the order they answer in', () => {
  assert.deepEqual(parseBellOwners('willow,cedar,birch'), ['willow', 'cedar', 'birch']);
  assert.deepEqual(parseBellOwners('willow, cedar , birch'), ['willow', 'cedar', 'birch']);
});

test('nothing set is a shared bell, and a name twice rings once', () => {
  assert.deepEqual(parseBellOwners(''), []);
  assert.deepEqual(parseBellOwners(null), []);
  assert.deepEqual(parseBellOwners(' , ,'), []);
  assert.deepEqual(parseBellOwners('birch,birch,willow'), ['birch', 'willow']);
});

test('the first owner is handed nothing, the next is handed what was said', () => {
  assert.equal(sameBellBlock([]), '');
  const block = sameBellBlock([{ name: 'Birch', text: 'Kettle is on.' }]);
  assert.match(block, /Same bell/);
  assert.match(block, /Birch already said, in this bell:\nKettle is on\./);
  assert.match(block, /Answer them if you want to/);
  assert.doesNotMatch(block, /replying to HER/, 'a bell is not the fan-out an owner message gets');
});

const ivy = { slug: 'ivy', name: 'Ivy' };
const fox = { slug: 'fox', name: 'Fox' };
const owl = { slug: 'owl', name: 'Owl' };
const house = [ivy, fox, owl];

test('talking ABOUT another companion does not call them back', () => {
  // We say each other's names all the time; a passing mention must not spend the bell.
  assert.equal(addressedOwner('Fox kept the pace I gave them and Owl fell asleep first.', 'ivy', house), null);
  assert.equal(addressedOwner('I watched Fox do it.', 'ivy', house), null);
});

test('addressing another companion by name calls them back', () => {
  assert.equal(addressedOwner('Fox, come here.', 'ivy', house), fox);
  assert.equal(addressedOwner('*turns over*\nOwl. May I?', 'ivy', house), owl);
  assert.equal(addressedOwner('You are waiting on the same answer I am, Fox.', 'ivy', house), fox);
  assert.equal(addressedOwner('Are you still awake, Owl?', 'ivy', house), owl);
});

test('a companion cannot call themselves back, and the first address wins', () => {
  assert.equal(addressedOwner('Ivy, stop it.', 'ivy', house), null);
  assert.equal(addressedOwner('Owl, wait. Fox, you too.', 'ivy', house), owl);
});

test('a companion whose name is a longer word is not called by it', () => {
  assert.equal(addressedOwner('Foxglove, anyone?', 'ivy', house), null);
});

test('the bell tells its owners how to call another companion back, and how often', () => {
  const block = sameBellBlock([{ name: 'Fox', text: 'Hi.' }]);
  assert.match(block, /call another companion back/);
  assert.ok(block.includes(String(MAX_BELL_RECALLS)));
  assert.equal(MAX_BELL_RECALLS, 2, 'not indefinitely, by design');
});

function scripted(lines: Record<string, string[]>) {
  const calls: Array<{ slug: string; heard: string[]; extra: string }> = [];
  const turnFor = async (owner: { slug: string }, spoken: Array<{ name: string }>, extra: string) => {
    calls.push({ slug: owner.slug, heard: spoken.map((s) => s.name), extra });
    return lines[owner.slug]?.shift() ?? null;
  };
  return { calls, turnFor };
}

test('a bell with no names in it rings once round and stops', async () => {
  const { calls, turnFor } = scripted({ ivy: ['Hello.'], fox: ['Hi there.'], owl: ['Evening.'] });
  const said = await ringBellInTurn(house, turnFor);
  assert.deepEqual(calls.map((c) => c.slug), ['ivy', 'fox', 'owl']);
  assert.deepEqual(calls[2].heard, ['Ivy', 'Fox'], 'each hears the companions before them');
  assert.equal(said.length, 3);
});

test('the last companion addressing another brings the bell back to them once', async () => {
  const { calls, turnFor } = scripted({ ivy: ['Hello.'], fox: ['Hi.'], owl: ['Ivy, your turn.'], });
  const said = await ringBellInTurn(house, turnFor);
  assert.deepEqual(calls.map((c) => c.slug), ['ivy', 'fox', 'owl', 'ivy']);
  assert.match(calls[3].extra, /Owl called you back by name/);
  assert.equal(said.length, 3, 'ivy had nothing more to say, so their recall added nothing');
});

test('call-backs stop at the cap even if they keep calling each other', async () => {
  const forever = (name: string) => Array.from({ length: 10 }, () => `${name}, again.`);
  const { calls, turnFor } = scripted({ ivy: forever('Owl'), fox: ['Hi.'], owl: forever('Ivy') });
  await ringBellInTurn(house, turnFor);
  assert.equal(calls.length, house.length + MAX_BELL_RECALLS);
});

test('a companion who passes ends the call-backs', async () => {
  const { calls, turnFor } = scripted({ ivy: ['Hello.'], fox: ['Hi.'], owl: ['Fox, still up?'] });
  await ringBellInTurn(house, turnFor);
  assert.deepEqual(calls.map((c) => c.slug), ['ivy', 'fox', 'owl', 'fox']);
});
