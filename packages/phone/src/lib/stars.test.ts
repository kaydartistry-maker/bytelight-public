// Stars on main (UI flip U2): the bubble's star is the human actor's star,
// live through message_starred/unstarred, optimistic with rollback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStarFrame, isStarredByMe, toggleStar, unstar, loadMyStars, HUMAN_STAR_ACTOR } from '../bytelight/stars';
import { getState, setState } from '../bytelight/store';

// apiFetch reads the CSRF cookie for writes; Node has no document.
(globalThis as { document?: unknown }).document ??= { cookie: '' };

test('frames add and remove one actor without touching the others', () => {
  setState({ starredBy: {} });
  applyStarFrame('message_starred', 'm1', HUMAN_STAR_ACTOR);
  applyStarFrame('message_starred', 'm1', 'companion-a');
  applyStarFrame('message_starred', 'm1', 'companion-a'); // a duplicate broadcast is a no-op
  assert.deepEqual(getState().starredBy, { m1: [HUMAN_STAR_ACTOR, 'companion-a'] });
  assert.equal(isStarredByMe(getState().starredBy, 'm1'), true);
  applyStarFrame('message_unstarred', 'm1', HUMAN_STAR_ACTOR);
  assert.equal(isStarredByMe(getState().starredBy, 'm1'), false, "a companion's star is not the viewer's");
  applyStarFrame('message_unstarred', 'm1', 'companion-a');
  assert.deepEqual(getState().starredBy, {});
});

await test('toggleStar posts the human actor and rolls back when main refuses', async () => {
  setState({ starredBy: {} });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await toggleStar('m2');
    assert.equal(isStarredByMe(getState().starredBy, 'm2'), true);
    assert.equal(calls[0].url, '/api/messages/m2/star');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body!), { starred_by: HUMAN_STAR_ACTOR });

    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await assert.rejects(toggleStar('m2'));
    assert.equal(isStarredByMe(getState().starredBy, 'm2'), true, 'a failed unstar puts the star back');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("unstar always DELETEs — even a companion's star the phone never seeded", async () => {
  setState({ starredBy: {} }); // only the viewer's stars are ever preloaded
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await unstar('m3', 'companion-b');
    assert.equal(calls[0].url, '/api/messages/m3/star');
    assert.equal(calls[0].method, 'DELETE');
    assert.deepEqual(JSON.parse(calls[0].body!), { starred_by: 'companion-b' });
    assert.deepEqual(getState().starredBy, {}, 'nothing is left behind locally');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("loadMyStars replaces the viewer's stars and keeps everyone else's", async () => {
  // m-stale was unstarred on another device while this one was offline.
  setState({ starredBy: { 'm-stale': [HUMAN_STAR_ACTOR], 'm-both': [HUMAN_STAR_ACTOR, 'companion-a'] } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [{ message_id: 'm-new' }] }), { status: 200 })) as typeof fetch;
  try {
    await loadMyStars();
    assert.deepEqual(getState().starredBy, { 'm-both': ['companion-a'], 'm-new': [HUMAN_STAR_ACTOR] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
