import assert from 'node:assert/strict';
import test from 'node:test';
import { runPerItem } from './per-item.js';

test('one failed item does not stop the rest of the batch', async () => {
  const seen: string[] = [];
  const result = await runPerItem(['a', 'b', 'c'], async (item) => {
    seen.push(item);
    if (item === 'b') throw new Error('no');
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(result, { done: ['a', 'c'], failed: ['b'] });
});

test('items run one at a time, in order', async () => {
  const log: string[] = [];
  await runPerItem([1, 2], async (item) => {
    log.push(`start ${item}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.push(`end ${item}`);
  });
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2']);
});
