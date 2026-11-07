// The think-and-thin nudge: a fresh session is told which core-memory blocks
// have grown past the budget, and how they are to be thinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initDb } from '../db/init.js';
import { setConfig } from '../db/config.js';
import { getAllBlocks, initMemoryBlocks, setBlock } from '../memory-blocks.js';
import { buildThinNudge, thinNudge, thinNudgeForTurn, DEFAULT_THIN_THRESHOLD_CHARS, THIN_THRESHOLD_KEY } from './thin-nudge.js';

const block = (scope: string, label: string, chars: number) => ({ scope, label, content: 'x'.repeat(chars) });

test('the default budget is 8k, and a block exactly at it is within it', () => {
  assert.equal(DEFAULT_THIN_THRESHOLD_CHARS, 8_000);
  assert.equal(thinNudge([block('shared', 'a', 8_000)], 8_000), '');
  assert.notEqual(thinNudge([block('companion-a', 'b', 8_001)], 8_000), '');
});

test('blocks over budget are named, biggest first, with their size', () => {
  const nudge = thinNudge([block('shared', 'small', 81_000), block('companion-b', 'big', 126_100)], 80_000);
  assert.match(nudge, /^\n\[Memory upkeep\] Core-memory blocks over the 80k budget: companion-b\/big \(126\.1k\), shared\/small \(81\.0k\)\./);
});

test('the wording asks for a pass by hand, in their own voice, keeping every fact and lesson', () => {
  const nudge = thinNudge([block('shared', 'big', 90_000)], 80_000);
  assert.match(nudge, /by hand/);
  assert.match(nudge, /in your own voice/);
  assert.match(nudge, /every fact and lesson/);
  assert.match(nudge, /clinical shorthand/);
  assert.doesNotMatch(nudge, /\/memory/, 'no such skill in this house');
});

test('the threshold comes from config, and the live blocks are what is measured', () => {
  initDb(':memory:');
  initMemoryBlocks();
  setBlock('shared', 'grown', 'y'.repeat(5_000));
  assert.equal(buildThinNudge(), '', 'under the 8k default');
  setConfig(THIN_THRESHOLD_KEY, '4000');
  assert.match(buildThinNudge(), /over the 4k budget: shared\/grown \(5\.0k\)/);
  setConfig(THIN_THRESHOLD_KEY, 'nonsense');
  assert.equal(buildThinNudge(), '', 'a bad setting falls back to the default');
  setConfig(THIN_THRESHOLD_KEY, '0');
  assert.equal(buildThinNudge(), '', 'zero would flag every block at once, so it falls back too');
  assert.ok(getAllBlocks().length > 0);
});

test('it is a nudge: it raises thinning with the owner and edits nothing without a yes', () => {
  const nudge = thinNudge([block('shared', 'big', 90_000)], 80_000);
  assert.match(nudge, /raise it with the owner/);
  assert.match(nudge, /Do not edit a block until the owner says yes/);
  assert.doesNotMatch(nudge, /^.*When the conversation allows, thin them/m, 'the old standing order is gone');
});

test('a lane is only told about shared blocks and its own', () => {
  const blocks = [block('shared', 'status', 9_000), block('companion-a', 'mine', 9_000), block('companion-b', 'his', 9_000)];
  const compA = thinNudge(blocks, 8_000, 'companion-a');
  assert.match(compA, /shared\/status/);
  assert.match(compA, /companion-a\/mine/);
  assert.doesNotMatch(compA, /companion-b\/his/);
  const compB = thinNudge(blocks, 8_000, 'companion-b');
  assert.doesNotMatch(compB, /companion-a\/mine/);
  assert.match(compB, /companion-b\/his/);
  assert.equal(thinNudge([block('companion-b', 'his', 9_000)], 8_000, 'companion-a'), '', 'nothing of its own over budget, nothing said');
});

test('the shared room is both of them, so it hears all of it', () => {
  const blocks = [block('shared', 'status', 9_000), block('companion-a', 'mine', 9_000), block('companion-b', 'his', 9_000)];
  const room = thinNudge(blocks, 8_000, 'primary');
  for (const name of ['shared/status', 'companion-a/mine', 'companion-b/his']) assert.ok(room.includes(name), name);
});

test('it only fires on a fresh session, on an owner turn, not on a wake', () => {
  initDb(':memory:');
  initMemoryBlocks();
  setBlock('shared', 'grown', 'y'.repeat(DEFAULT_THIN_THRESHOLD_CHARS + 1));
  const turn = { fresh: true, guest: false, autonomous: false, laneKey: 'primary' };
  assert.match(thinNudgeForTurn(turn), /shared\/grown/);
  assert.equal(thinNudgeForTurn({ ...turn, fresh: false }), '', 'a warm turn');
  assert.equal(thinNudgeForTurn({ ...turn, guest: true }), '', 'a guest does not hear the walls discussed');
  assert.equal(thinNudgeForTurn({ ...turn, autonomous: true }), '', 'a wake has nobody to raise it with');
});

test('the runtime asks with this turn, and the note rides ahead of the bridge', () => {
  // runTurn needs a live CLI child, so its wiring is read off the source. The
  // bridge's closing line tells the room the next thing is the owner's message,
  // so the note must not sit after it.
  const src = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
  assert.match(src, /thinNudgeForTurn\(\{ fresh, guest: guestTurn, autonomous: input\.isAutonomous, laneKey: key \}\)/);
  assert.equal(src.includes('+ buildThinNudge()'), false, 'and no longer stapled to the recycle context');
  assert.match(src, /const baseChars = \(thinBlock \+ contextBlock \+/);
  assert.match(src, /deliveredContent =\s+thinBlock \+ contextBlock \+/);
  assert.ok(src.indexOf('const guestTurn =') < src.indexOf('const thinBlock ='), 'guestTurn is known before it is asked for');
});
