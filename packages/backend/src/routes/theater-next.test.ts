// The Theater's "next one": the companions end the night and start the next
// episode, which finds its own subtitles. No network: a stand-in OpenSubtitles
// answers every outside call and counts them. Titles and lines are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'theater-next-test-'));
process.env.RESONANT_HOME = tmpRoot;
process.env.DB_PATH = join(tmpRoot, 'bytelight.db');
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { getNight } = await import('../services/theater.js');
const { couchTalk } = await import('../services/theater-couch.js');
const { clearSubtitleSearchCache } = await import('../services/theater-subs-fetch.js');
const { stopTheaterMouth, theaterMouthNightId } = await import('../services/theater-mouth.js');
const { setConfig } = await import('../services/db/config.js');
const { LOCAL_COMPANION_ID } = await import('../services/agent.js');
const theaterRoutes = (await import('./theater.js')).default;

initDb(':memory:');
getDb().prepare('DELETE FROM companions').run();
for (const [slug, name] of [['companion-a', 'Companion A'], ['companion-b', 'Companion B']]) {
  getDb().prepare('INSERT INTO companions (id, display_name, brain) VALUES (?, ?, ?)').run(slug, name, LOCAL_COMPANION_ID);
}

async function listen(app: express.Express): Promise<{ base: string }> {
  const server = app.listen(0, '127.0.0.1');
  server.unref();
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const realFetch = globalThis.fetch;

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

// A lane that never answers anything: these tests don't wake the couch.
const lane = { async processMessage(): Promise<string> { return ''; } };

const internalApp = express();
internalApp.set('trust proxy', 1);
internalApp.use(express.json());
internalApp.locals.agentService = lane;
internalApp.use('/api', createInternalRoutes());
const door = await listen(internalApp);

const phoneApp = express();
phoneApp.use(express.json());
phoneApp.locals.agentService = lane;
phoneApp.use('/api/theater', theaterRoutes);
const phone = await listen(phoneApp);

const SRT = [
  '1', '00:00:05,000 --> 00:00:07,000', 'Who left the gate open?', '',
  '2', '00:00:09,000 --> 00:00:11,000', 'Not me.', '',
].join('\r\n');

// The stand-in OpenSubtitles: episodes 7 and 8 of season 2 have subtitles; nothing else does.
const outside: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  outside.push(url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/subtitles?')) {
    const ep = Number(/episode_number=(\d+)/.exec(url)?.[1]);
    if (ep !== 7 && ep !== 8) return json(200, { data: [] });
    return json(200, {
      data: [{
        attributes: {
          language: 'en', download_count: 50, release: `Harbor.S02E0${ep}.HDTV`,
          feature_details: { feature_type: 'Episode', parent_title: 'The Quiet Harbor', season_number: 2, episode_number: ep },
          files: [{ file_id: 800 + ep, file_name: `e${ep}.srt` }],
        },
      }],
    });
  }
  if (url.endsWith('/download')) {
    return json(200, { link: `https://dl.example.test/${JSON.parse(String(init?.body)).file_id}`, remaining: 3 });
  }
  if (url.startsWith('https://dl.example.test/')) return new Response(SRT, { status: 200 });
  return json(404, {});
}) as typeof fetch;
setConfig('secret:opensubtitles_api_key', 'test-key-not-real');
clearSubtitleSearchCache();

const downloads = () => outside.filter((u) => u.endsWith('/download')).length;
const nextOf = (id: string, headers: Record<string, string> = {}) => call(door.base, 'POST', `/api/internal/theater/nights/${id}/next`, {}, headers);

test.after(() => {
  globalThis.fetch = realFetch;
  stopTheaterMouth();
});

let firstId = '';
let secondId = '';
let thirdId = '';

test('the next-episode door is localhost only', async () => {
  const res = await nextOf('00000000-0000-0000-0000-000000000000', { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(res.status, 403);
  assert.equal((await nextOf('00000000-0000-0000-0000-000000000000')).status, 404);
});

test('next one: the night ends, the next episode starts with her settings and its own subtitles, and the Mouth follows', async () => {
  const started = await call(phone.base, 'POST', '/api/theater/nights', { title: 'The Quiet Harbor', season: 2, episode: 7, chatty: 80, noSpoilers: false });
  assert.equal(started.status, 201);
  firstId = started.json.night.id;
  // She is watching: subtitles found, the clock playing, the Mouth listening to this night.
  assert.equal((await call(phone.base, 'POST', `/api/theater/nights/${firstId}/subtitles/find`, {})).status, 200);
  const playing = await call(phone.base, 'POST', `/api/theater/nights/${firstId}/clock`, { action: 'resync', position: 2400, playing: true });
  assert.equal(playing.json.mouth.armed, true);
  assert.equal(theaterMouthNightId(), firstId);
  const before = downloads();

  const res = await nextOf(firstId);
  assert.equal(res.status, 200);
  const night = res.json.night;
  secondId = night.id;
  assert.notEqual(secondId, firstId);
  assert.equal(night.status, 'live');
  assert.equal(night.title, 'The Quiet Harbor');
  assert.equal(night.season, 2);
  assert.equal(night.episode, 8);
  assert.equal(night.chatty, 80, 'how chatty carries over');
  assert.equal(night.noSpoilers, false, 'no spoilers carries over');
  assert.equal(night.mouthOn, true);
  assert.notEqual(night.threadId, started.json.night.threadId, 'its own couch thread');
  assert.deepEqual(res.json.subtitles, { loaded: true, name: 'Harbor.S02E08.HDTV', error: null });
  assert.equal(night.subtitleSource, 'opensubtitles');
  assert.equal(night.cueCount, 2);
  assert.equal(downloads() - before, 1, 'one download from the day');
  assert.ok(outside.some((u) => u.includes('episode_number=8') && u.includes('season_number=2')));
  assert.match(res.json.note, /Subtitles loaded: Harbor\.S02E08\.HDTV/);

  // The old night is over and points at the new one.
  const old = getNight(firstId)!;
  assert.equal(old.status, 'ended');
  assert.equal(old.nextNightId, secondId);
  assert.equal(res.json.previous.status, 'ended');
  assert.equal(res.json.previous.nextNightId, secondId);

  // The phone's home now opens on the new night; the old one reads as past.
  const home = await call(phone.base, 'GET', '/api/theater');
  assert.equal(home.json.live.night.id, secondId);
  assert.ok(home.json.past.some((n: any) => n.id === firstId && n.nextNightId === secondId));
  const oldView = await call(phone.base, 'GET', `/api/theater/nights/${firstId}`);
  assert.equal(oldView.json.night.status, 'ended');
  assert.equal(oldView.json.night.nextNightId, secondId);

  // The house says on the new couch what was loaded.
  assert.ok(couchTalk(getNight(secondId)!).some((l) => l.role === 'system' && /Subtitles found and loaded: Harbor\.S02E08\.HDTV/.test(l.content)));

  // The Mouth let go of the old night; the new clock waits for play, then it listens there.
  assert.equal(theaterMouthNightId(), null);
  const nowPlaying = await call(phone.base, 'POST', `/api/theater/nights/${secondId}/clock`, { action: 'play' });
  assert.equal(nowPlaying.json.mouth.armed, true);
  assert.equal(theaterMouthNightId(), secondId);
});

test('asked twice, it answers with the night it already started: no second night, no second download', async () => {
  const before = downloads();
  const again = await nextOf(firstId);
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
  assert.equal(again.json.night.id, secondId);
  assert.equal(downloads(), before);
  assert.equal(getNight(secondId)!.status, 'live');
});

test('no subtitles found: the next night still starts and says so; "Let them react" off carries over', async () => {
  assert.equal((await call(phone.base, 'PATCH', `/api/theater/nights/${secondId}`, { mouthOn: false })).status, 200);
  const before = downloads();
  const res = await nextOf(secondId);
  assert.equal(res.status, 200);
  assert.equal(res.json.night.status, 'live');
  assert.equal(res.json.night.episode, 9);
  assert.equal(res.json.night.cueCount, 0);
  assert.equal(res.json.night.mouthOn, false, '"Let them react" stays off');
  assert.equal(res.json.night.chatty, 80);
  assert.equal(res.json.subtitles.loaded, false);
  assert.match(res.json.subtitles.error, /No English subtitles turned up for The Quiet Harbor S2·E9/);
  assert.match(res.json.note, /She can load a file/);
  assert.equal(downloads(), before, 'nothing found, nothing downloaded');
  assert.equal(getNight(secondId)!.status, 'ended');
  assert.equal(theaterMouthNightId(), null, 'the Mouth is not left on the old night');
  const third = getNight(res.json.night.id)!;
  thirdId = third.id;
  assert.ok(couchTalk(third).some((l) => l.role === 'system' && /No subtitles loaded/.test(l.content)));
  await call(phone.base, 'POST', `/api/theater/nights/${third.id}/end`);
});

test('a movie night, or one without both season and episode, is refused and keeps playing', async () => {
  const movie = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Lantern Bay' });
  const movieId = movie.json.night.id;
  const refused = await nextOf(movieId);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /movie night/);
  assert.equal(getNight(movieId)!.status, 'live', 'still playing');
  await call(phone.base, 'POST', `/api/theater/nights/${movieId}/end`);

  const half = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Lantern Bay', season: 1 });
  const halfId = half.json.night.id;
  const refusedHalf = await nextOf(halfId);
  assert.equal(refusedHalf.status, 400);
  assert.equal(getNight(halfId)!.status, 'live');
  assert.equal(getNight(halfId)!.nextNightId ?? null, null);
  await call(phone.base, 'POST', `/api/theater/nights/${halfId}/end`);
});

test('the next episode follows the night that is playing, not an old one', async () => {
  const live = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Other Show', season: 1, episode: 1 });
  assert.equal(live.status, 201);
  const refused = await nextOf(thirdId);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /Another night is on/);
  assert.equal(getNight(live.json.night.id)!.status, 'live');
  await call(phone.base, 'POST', `/api/theater/nights/${live.json.night.id}/end`);
});

test('her "Next episode" button on the phone does the same move, behind the phone door', async () => {
  const live = await call(phone.base, 'POST', '/api/theater/nights', { title: 'The Quiet Harbor', season: 2, episode: 7, chatty: 60 });
  assert.equal(live.status, 201);
  const firstId = live.json.night.id;
  const res = await call(phone.base, 'POST', `/api/theater/nights/${firstId}/next`);
  assert.equal(res.status, 200);
  assert.equal(res.json.night.episode, 8);
  assert.equal(res.json.night.status, 'live');
  assert.equal(res.json.night.chatty, 60);
  assert.equal(res.json.subtitles.loaded, true);
  assert.equal(getNight(firstId)!.status, 'ended');
  assert.equal(getNight(firstId)!.nextNightId, res.json.night.id);
  await call(phone.base, 'POST', `/api/theater/nights/${res.json.night.id}/end`);

  const movie = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Lantern Bay' });
  const refused = await call(phone.base, 'POST', `/api/theater/nights/${movie.json.night.id}/next`);
  assert.equal(refused.status, 400);
  await call(phone.base, 'POST', `/api/theater/nights/${movie.json.night.id}/end`);
});
