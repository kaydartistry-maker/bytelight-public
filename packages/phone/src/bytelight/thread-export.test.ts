import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWholeThread, type FetchPage } from './thread-export';
import type { Message } from './protocol';

const msgs = Array.from({ length: 7 }, (_, i) => ({ id: `m${i + 1}`, sequence: i + 1 }) as unknown as Message);

// A stand-in for GET /threads/:id/messages: newest `limit` before the cursor, oldest first.
const fakePage: FetchPage = async (_thread, before, limit) => {
  const end = before ? msgs.findIndex((m) => m.id === before) : msgs.length;
  return msgs.slice(Math.max(0, end - limit), end);
};

test('walks back page by page to the start of the thread', async () => {
  const all = await fetchWholeThread('t1', fakePage, 3);
  assert.deepEqual(all.map((m) => m.id), msgs.map((m) => m.id));
});

test('a thread that fits in one page takes one request', async () => {
  let calls = 0;
  const all = await fetchWholeThread('t1', async (...a) => { calls++; return fakePage(...a); }, 50);
  assert.equal(all.length, 7);
  assert.equal(calls, 1);
});

test('a failed page fails the export instead of returning part of it', async () => {
  let calls = 0;
  await assert.rejects(fetchWholeThread('t1', async (...a) => {
    if (++calls === 2) throw new Error('Could not load the conversation (500).');
    return fakePage(...a);
  }, 3), /Could not load/);
});
