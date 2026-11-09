// The Book Club over HTTP: her door, the companions' loopback door, and the
// turn in between. The lane here is a stand-in that pitches and votes through
// the real loopback door, the way the companions do, so a round is checked
// end to end. Config boots on defaults in a scratch RESONANT_HOME, so the
// Library's folder (beside the database path) is scratch too.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'book-club-routes-test-'));
process.env.RESONANT_HOME = tmpRoot;
// The Library's folder sits beside the database: keep both in the scratch home.
process.env.DB_PATH = join(tmpRoot, 'bytelight.db');
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { getThread } = await import('../services/db/threads.js');
const { getThreadRoster } = await import('../services/db/rooms.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { bookClubTurnsIdle, bookClubThreadId } = await import('../services/library-book-club-turns.js');
const { readShelf } = await import('../services/library.js');
const { LOCAL_COMPANION_ID } = await import('../services/agent.js');
const bookClubRoutes = (await import('./library-book-club.js')).default;
const libraryRoutes = (await import('./library.js')).default;

initDb(':memory:');
getDb().prepare('DELETE FROM companions').run();
// Two companions who live in this house, and one registered here who lives in his own.
for (const [slug, name, brain] of [['companion-a', 'Companion A', LOCAL_COMPANION_ID], ['companion-b', 'Companion B', LOCAL_COMPANION_ID], ['visitor', 'Visitor', 'other']]) {
  getDb().prepare('INSERT INTO companions (id, display_name, brain) VALUES (?, ?, ?)').run(slug, name, brain);
}

async function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

const internalApp = express();
internalApp.set('trust proxy', 1);
internalApp.use(express.json());
internalApp.use('/api', createInternalRoutes());
const door = await listen(internalApp);

interface LaneCall { threadId: string; prompt: string }
const laneCalls: LaneCall[] = [];
/** What the stand-in companions do on their turn. */
let onTurn: (roundId: string) => Promise<string> = async () => 'ok';
const lane = {
  async processMessage(threadId: string, prompt: string): Promise<string> {
    laneCalls.push({ threadId, prompt });
    const roundId = /Round ([0-9a-f-]{36})\./.exec(prompt)?.[1] ?? '';
    return onTurn(roundId);
  },
};

const phoneApp = express();
phoneApp.use(express.json());
phoneApp.locals.agentService = lane;
phoneApp.use('/api/library/book-club', bookClubRoutes);
phoneApp.use('/api/library', libraryRoutes);
const phone = await listen(phoneApp);

test.after(() => { door.close(); phone.close(); });

const pitch = (roundId: string, body: unknown) => call(door.base, 'POST', `/api/internal/library/book-club/rounds/${roundId}/pitches`, body);
const vote = (roundId: string, body: unknown) => call(door.base, 'POST', `/api/internal/library/book-club/rounds/${roundId}/votes`, body);

test('the companions door refuses anyone not on this machine', async () => {
  const relayed = { 'x-forwarded-for': '203.0.113.9' };
  for (const [method, path] of [
    ['GET', '/api/internal/library/book-club'],
    ['POST', '/api/internal/library/book-club/rounds/x/pitches'],
    ['POST', '/api/internal/library/book-club/rounds/x/votes'],
  ] as const) {
    const res = await call(door.base, method, path, method === 'POST' ? {} : undefined, relayed);
    assert.equal(res.status, 403, path);
    assert.deepEqual(res.json, { error: 'Localhost only' });
  }
});

test('starting a round wakes the companions once; they pitch and vote through the door', async () => {
  onTurn = async (roundId) => {
    const s = await pitch(roundId, { by: 'companion-a', title: 'Dracula', author: 'Bram Stoker', pitch: 'Letters and dread.', gutenbergId: 345 });
    const t = await pitch(roundId, { by: 'companion-b', title: 'Rebecca', author: 'Daphne du Maurier', pitch: 'A house that remembers.' });
    assert.equal(s.status, 201);
    assert.equal(t.status, 201);
    await vote(roundId, { voter: 'companion-a', pitchId: t.json.pitch.id });
    await vote(roundId, { voter: 'companion-b', pitchId: s.json.pitch.id });
    return 'table talk';
  };
  const started = await call(phone.base, 'POST', '/api/library/book-club/rounds', { pitch: { title: 'Emma', author: 'Jane Austen' } });
  assert.equal(started.status, 201);
  assert.equal(started.json.woke, true);
  assert.equal(started.json.current.turn.state, 'waiting');
  const roundId = started.json.current.id;

  const again = await call(phone.base, 'POST', '/api/library/book-club/rounds', {});
  assert.equal(again.status, 409, 'one round at a time');

  await bookClubTurnsIdle();
  assert.equal(laneCalls.length, 1);
  const threadId = bookClubThreadId();
  assert.equal(laneCalls[0].threadId, threadId);
  assert.ok(getThread(threadId!)?.archived_at, 'the club thread is archived');
  assert.match(laneCalls[0].prompt, /\[THE BOOK CLUB — .+ started a round\]/);
  assert.match(laneCalls[0].prompt, /Emma/, 'her pitch is in the turn');
  assert.match(laneCalls[0].prompt, /api\/internal\/library\/book-club\/rounds\/[0-9a-f-]+\/pitches/);

  const view = (await call(phone.base, 'GET', '/api/library/book-club')).json;
  assert.equal(view.current.id, roundId);
  assert.equal(view.current.turn.state, 'idle');
  assert.equal(view.current.pitches.length, 3);
  assert.deepEqual(view.seats.map((s: { id: string }) => s.id), ['companion-a', 'companion-b']);

  // Only this house's companions are at the table: the one who lives elsewhere
  // isn't seated, isn't waited on (the turn above settled idle), and the door refuses him.
  assert.deepEqual(getThreadRoster(threadId!).map((c) => c.id).sort(), ['companion-a', 'companion-b']);
  const visitorPitch = await pitch(roundId, { by: 'visitor', title: 'X', pitch: 'y' });
  assert.equal(visitorPitch.status, 400);
  assert.match(visitorPitch.json.error, /by must be one of: owner, companion-a, companion-b\./);
  assert.equal((await vote(roundId, { voter: 'visitor', pitchId: view.current.pitches[0].id })).status, 400);
  assert.doesNotMatch(laneCalls[0].prompt, /Visitor|visitor/);

  // The companions can't take her seat, and can't vote for a pitch that isn't there.
  assert.equal((await pitch(roundId, { by: 'owner', title: 'X', pitch: 'y' })).status, 400);
  assert.equal((await vote(roundId, { voter: 'owner', pitchId: view.current.pitches[0].id })).status, 400);
  assert.equal((await vote(roundId, { voter: 'companion-a', pitchId: 'nope' })).status, 400);

  // A tie (1–1, her pitch 0): she must pick, and only between the tied.
  const her = view.current.pitches.find((p: { by: string }) => p.by === 'owner');
  const dracula = view.current.pitches.find((p: { title: string }) => p.title === 'Dracula');
  assert.equal((await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/pick`, {})).status, 409);
  assert.equal((await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/pick`, { pitchId: her.id })).status, 409);

  // Her vote breaks it; she votes once, and moving it moves it.
  await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/votes`, { pitchId: her.id });
  const voted = await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/votes`, { pitchId: dracula.id });
  assert.equal(voted.json.current.votes.owner, dracula.id);
  assert.equal(voted.json.current.tally[dracula.id], 2);
  assert.deepEqual(voted.json.current.leaders, [dracula.id]);

  // The winner is a Gutenberg book not on the shelf: it is fetched (stubbed) onto Reading.
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!/gutendex|gutenberg/.test(u)) return realFetch(url, init);
    fetched.push(u);
    const meta = { id: 345, title: 'Dracula', authors: [{ name: 'Stoker, Bram' }], languages: ['en'], download_count: 1, formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/345.txt.utf-8' } };
    return new Response(u.includes('.txt') ? `CHAPTER I\n\n${'Jonathan kept a journal. '.repeat(40)}` : JSON.stringify(meta), { status: 200 });
  }) as typeof fetch;
  try {
    const picked = await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/pick`, {});
    assert.equal(picked.status, 200);
    assert.equal(picked.json.current.status, 'reading');
    assert.equal(picked.json.current.winnerPitchId, dracula.id);
    assert.equal(picked.json.current.bookId, 345);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(fetched.length > 0);
  assert.equal(readShelf().find((e) => e.id === 345)?.shelf, 'reading');

  // Past pitching now.
  assert.equal((await pitch(roundId, { by: 'companion-a', title: 'Late', pitch: 'x' })).status, 409);
  const done = await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/finish`, {});
  assert.equal(done.json.current, null);
  assert.equal(done.json.past[0].id, roundId);
  assert.equal(done.json.past[0].status, 'finished');
});

test('a turn that comes back without their pitches says so, and asking again wakes them once more', async () => {
  laneCalls.length = 0;
  onTurn = async (roundId) => {
    await pitch(roundId, { by: 'companion-a', title: 'Frankenstein', pitch: 'Lightning and loneliness.' });
    return 'ok';
  };
  const started = await call(phone.base, 'POST', '/api/library/book-club/rounds', {});
  const roundId = started.json.current.id;
  await bookClubTurnsIdle();
  let view = (await call(phone.base, 'GET', '/api/library/book-club')).json;
  assert.equal(view.current.turn.state, 'empty');
  assert.match(view.current.turn.note, /Companion B's pitch/);

  onTurn = async (id) => {
    await pitch(id, { by: 'companion-b', title: 'Carmilla', pitch: 'Older than Dracula, and hungrier.' });
    const p = (await call(door.base, 'GET', '/api/internal/library/book-club')).json.current.pitches;
    await vote(id, { voter: 'companion-a', pitchId: p[1].id });
    await vote(id, { voter: 'companion-b', pitchId: p[0].id });
    return 'ok';
  };
  const asked = await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/ask`, {});
  assert.equal(asked.json.current.turn.state, 'waiting');
  await bookClubTurnsIdle();
  assert.equal(laneCalls.length, 2);
  assert.match(laneCalls[1].prompt, /asked you to look at the round again/);
  view = (await call(phone.base, 'GET', '/api/library/book-club')).json;
  assert.equal(view.current.turn.state, 'idle');
  assert.equal(view.current.pitches.length, 2);

  // Set aside without a winner.
  const done = await call(phone.base, 'POST', `/api/library/book-club/rounds/${roundId}/finish`, {});
  assert.equal(done.json.past[0].winnerPitchId, null);
});

test('her review goes on the book over the shelf route', async () => {
  // Dracula landed on the shelf in the round above.
  const bad = await call(phone.base, 'PUT', '/api/library/books/345/review', { stars: 9 });
  assert.equal(bad.status, 400);
  const ok = await call(phone.base, 'PUT', '/api/library/books/345/review', { stars: 4, text: 'The boat chapter!' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.book.review.stars, ok.json.book.review.text], [4, 'The boat chapter!']);
  const shelf = (await call(phone.base, 'GET', '/api/library/shelf')).json.books;
  assert.equal(shelf.find((b: { id: number }) => b.id === 345).review.stars, 4);
  assert.equal((await call(phone.base, 'PUT', '/api/library/books/999/review', { stars: 3 })).status, 404);
  const cleared = await call(phone.base, 'PUT', '/api/library/books/345/review', { stars: null });
  assert.equal(cleared.json.book.review, undefined);
});
