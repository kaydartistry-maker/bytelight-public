// A fresh install has no thread; the first message must open one, not vanish.
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as { document?: unknown }).document = { cookie: '' };

const calls: Array<{ url: string; method: string; body?: string }> = [];
let failCreate = false;
(globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url === '/api/companions') return json(200, { companions: [{ id: 'resident-a' }] });
  if (url === '/api/threads' && method === 'POST') {
    return failCreate ? json(500, { error: 'nope' }) : json(200, { thread: { id: 'thread-1' } });
  }
  if (url === '/api/threads') return json(200, { threads: [] });
  return json(200, { messages: [], hasMore: false });
};

const { sendUserMessage, ensureActiveThread } = await import('./socket');
const { getState, setState } = await import('./store');

test('with no thread open, a send fails loudly when the thread cannot be made', async () => {
  failCreate = true;
  setState({ activeThreadId: null, threads: [] });
  await assert.rejects(sendUserMessage('hello'), /Could not create the thread/);
  failCreate = false;
});

test('with no thread open, the first send creates one seated with the residents', async () => {
  calls.length = 0;
  setState({ activeThreadId: null, threads: [] });
  await sendUserMessage('hello');
  const create = calls.find((c) => c.url === '/api/threads' && c.method === 'POST');
  assert.ok(create, 'a thread was created');
  assert.deepEqual(JSON.parse(create!.body!).companionIds, ['resident-a']);
  assert.equal(getState().activeThreadId, 'thread-1');
});

test('two quick sends share one new thread', async () => {
  calls.length = 0;
  setState({ activeThreadId: null, threads: [] });
  const [a, b] = await Promise.all([ensureActiveThread(), ensureActiveThread()]);
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c.url === '/api/threads' && c.method === 'POST').length, 1);
});

test('an open thread is used as is', async () => {
  calls.length = 0;
  setState({ activeThreadId: 'open-one' });
  assert.equal(await ensureActiveThread(), 'open-one');
  assert.equal(calls.length, 0);
});
