// The Theater over HTTP: her door, the companions' loopback door, and the
// couch turn in between, with a stand-in lane that records what it was handed.
// Config boots on defaults in a scratch home, so data/theater is scratch too.
// Subtitles here are made up.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

const { mkdtempSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'theater-routes-test-'));
process.env.RESONANT_HOME = tmpRoot;
process.env.DB_PATH = join(tmpRoot, 'bytelight.db');
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { setSecret, deleteSecret } = await import('../services/secrets.js');
const { setupTestVault } = await import('../services/vault-test-support.js');
after(setupTestVault('theater-routes'));
const { getThread } = await import('../services/db/threads.js');
const { getThreadRoster } = await import('../services/db/rooms.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { theaterTurnsIdle, buildTheaterPrompt, theaterTurnContext } = await import('../services/theater-couch.js');
const { theaterDir, getNight } = await import('../services/theater.js');
const { LOCAL_COMPANION_ID } = await import('../services/agent.js');
const theaterRoutes = (await import('./theater.js')).default;

initDb(':memory:');
getDb().prepare('DELETE FROM companions').run();
for (const [slug, name, brain] of [['companion-a', 'Companion A', LOCAL_COMPANION_ID], ['companion-b', 'Companion B', LOCAL_COMPANION_ID], ['visitor', 'Visitor', 'other']]) {
  getDb().prepare('INSERT INTO companions (id, display_name, brain) VALUES (?, ?, ?)').run(slug, name, brain);
}

async function listen(app: express.Express): Promise<{ base: string }> {
  const server = app.listen(0, '127.0.0.1');
  server.unref();
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}` };
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

async function uploadSubs(base: string, nightId: string, name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/x-subrip' }), name);
  const res = await fetch(`${base}/api/theater/nights/${nightId}/subtitles`, { method: 'POST', body: form });
  return { status: res.status, json: await res.json() as any };
}

const internalApp = express();
internalApp.set('trust proxy', 1);
internalApp.use(express.json());
internalApp.use('/api', createInternalRoutes());
const door = await listen(internalApp);

const laneCalls: Array<{ threadId: string; prompt: string; meta: unknown; opts: unknown }> = [];
let hold: Promise<void> | null = null;
let reply: string | Error = 'couch talk';
const lane = {
  async processMessage(threadId: string, prompt: string, meta?: unknown, opts?: unknown): Promise<string> {
    laneCalls.push({ threadId, prompt, meta, opts });
    if (hold) await hold;
    if (reply instanceof Error) throw reply;
    return reply;
  },
};

const phoneApp = express();
phoneApp.use(express.json());
phoneApp.locals.agentService = lane;
phoneApp.use('/api/theater', theaterRoutes);
const phone = await listen(phoneApp);

// A made-up episode: two lines before 00:02:00, one far before, and a twist after.
const SRT = [
  '1', '00:00:05,000 --> 00:00:07,000', 'Long ago line.', '',
  '2', '00:01:00,000 --> 00:01:03,000', '<i>Is the door locked?</i>', '',
  '3', '00:01:50,000 --> 00:01:52,000', 'I checked it twice.', '',
  '4', '00:02:30,000 --> 00:02:33,000', 'THE BUTLER DID IT', '',
].join('\r\n');

test("the companions' door refuses anyone not on this machine", async () => {
  const res = await call(door.base, 'GET', '/api/internal/theater', undefined, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { error: 'Localhost only' });
  const quiet = await call(door.base, 'GET', '/api/internal/theater');
  assert.equal(quiet.status, 200);
  assert.equal(quiet.json.live, false);
});

let nightId = '';

test('starting a night: checked input, its own archived couch thread, local companions only, one live at a time', async () => {
  assert.equal((await call(phone.base, 'POST', '/api/theater/nights', {})).status, 400);
  assert.equal((await call(phone.base, 'POST', '/api/theater/nights', { title: 'X', mode: 'radio' })).status, 400);
  const started = await call(phone.base, 'POST', '/api/theater/nights', { title: 'The Quiet Harbor', season: 1, episode: 3, chatty: 70, noSpoilers: true });
  assert.equal(started.status, 201);
  const night = started.json.night;
  nightId = night.id;
  assert.equal(night.status, 'live');
  assert.equal(night.chatty, 70);
  assert.equal(night.noSpoilers, true);
  assert.equal(started.json.clock.paused, true);
  assert.equal(started.json.clock.position, 0);
  const thread = getThread(night.threadId);
  assert.ok(thread?.archived_at, 'the couch thread is archived, not in the chat list');
  assert.deepEqual(getThreadRoster(night.threadId).map((c: any) => c.id ?? c.companion_id ?? c).sort(), ['companion-a', 'companion-b']);
  assert.ok(existsSync(join(theaterDir(), 'nights', `${nightId}.json`)));

  const second = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Another' });
  assert.equal(second.status, 409);
  const threads = getDb().prepare("SELECT COUNT(*) AS n FROM threads WHERE name LIKE 'The Theater%'").get() as { n: number };
  assert.equal(threads.n, 1, 'a refused start leaves no empty thread behind');
});

test('subtitles upload, and the clock moves', async () => {
  const bad = await uploadSubs(phone.base, nightId, 'notes.txt', SRT);
  assert.equal(bad.status, 400);
  const empty = await uploadSubs(phone.base, nightId, 'x.srt', 'nothing here');
  assert.equal(empty.status, 400);
  const ok = await uploadSubs(phone.base, nightId, 'harbor-s1e3.srt', SRT);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.night.cueCount, 4);

  const set = await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'resync', position: 120, playing: false });
  assert.equal(set.status, 200);
  assert.equal(set.json.clock.position, 120);
  assert.deepEqual(set.json.caption.map((c: any) => c.text), ['Is the door locked?', 'I checked it twice.']);
  const back = await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'seek', delta: -5 });
  assert.equal(back.json.clock.position, 115);
  const fwd = await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'seek', delta: 5 });
  assert.equal(fwd.json.clock.position, 120);
  assert.equal((await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'jump' })).status, 400);
  assert.equal((await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'seek' })).status, 400);

  const peek = await call(door.base, 'GET', '/api/internal/theater');
  assert.equal(peek.json.live, true);
  assert.equal(peek.json.clock.position, 120);
  assert.deepEqual(peek.json.lookback.map((c: any) => c.text), ['Is the door locked?', 'I checked it twice.']);
  assert.ok(!JSON.stringify(peek.json).includes('BUTLER'), "the companions' door never shows a line after the clock");
});

test('a couch line becomes one turn that sees only what has played', async () => {
  laneCalls.length = 0;
  const said = await call(phone.base, 'POST', `/api/theater/nights/${nightId}/say`, { text: 'he is lying' });
  assert.equal(said.status, 201);
  assert.equal(said.json.woke, true);
  await theaterTurnsIdle();
  assert.equal(laneCalls.length, 1);
  const { prompt, threadId, meta, opts } = laneCalls[0];
  const night = getNight(nightId)!;
  assert.equal(threadId, night.threadId);
  assert.deepEqual(meta, { name: 'The Theater', type: 'named' });
  assert.deepEqual(opts, { platform: 'api', passLeavesNothing: true });
  assert.match(prompt, /The Quiet Harbor · S1E3/);
  assert.match(prompt, /00:02:00 \(paused\)/);
  assert.match(prompt, /Is the door locked\?/);
  assert.match(prompt, /I checked it twice\./);
  assert.match(prompt, /he is lying/);
  assert.match(prompt, /api\/internal\/theater/);
  assert.doesNotMatch(prompt, /BUTLER/);
  assert.doesNotMatch(prompt, /Long ago line/, 'older than the lookback window');
  assert.doesNotMatch(prompt, /Visitor/, 'only the companions who live here are on the couch');
  assert.equal(getNight(nightId)!.turn.state, 'idle');

  const view = await call(phone.base, 'GET', `/api/theater/nights/${nightId}`);
  const mine = view.json.talk.filter((l: any) => l.role === 'user');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].at, 120);
});

test('lines said mid-turn wait, then go in one turn together; a reaction is her line', async () => {
  laneCalls.length = 0;
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  await call(phone.base, 'POST', `/api/theater/nights/${nightId}/say`, { text: 'first' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(laneCalls.length, 1);
  await call(phone.base, 'POST', `/api/theater/nights/${nightId}/say`, { text: '😱' });
  await call(phone.base, 'POST', `/api/theater/nights/${nightId}/say`, { text: 'no way' });
  assert.equal(getNight(nightId)!.turn.state, 'waiting');
  hold = null;
  release();
  await theaterTurnsIdle();
  assert.equal(laneCalls.length, 2, 'two lines said mid-turn became one turn');
  assert.match(laneCalls[1].prompt, /😱[\s\S]*no way/);
  assert.doesNotMatch(laneCalls[1].prompt, /first/);
  assert.equal(getNight(nightId)!.turn.state, 'idle');
});

test('the prompt builder is handed the window, never later cues', () => {
  const night = getNight(nightId)!;
  const ctx = theaterTurnContext(night);
  assert.ok(ctx.heard.every((c) => c.start <= ctx.position));
  const prompt = buildTheaterPrompt({ owner: 'Operator', port: 1, seats: [], ...ctx, cause: { kind: 'beat', note: 'a quiet moment' } });
  assert.doesNotMatch(prompt, /BUTLER/);
  assert.match(prompt, /a quiet moment/);
});

test('ending keeps the night; past nights list it and it reads back, read-only', async () => {
  const ended = await call(phone.base, 'POST', `/api/theater/nights/${nightId}/end`);
  assert.equal(ended.status, 200);
  assert.equal(ended.json.night.status, 'ended');
  assert.equal((await call(phone.base, 'POST', `/api/theater/nights/${nightId}/say`, { text: 'hello?' })).status, 409);
  assert.equal((await call(phone.base, 'POST', `/api/theater/nights/${nightId}/clock`, { action: 'play' })).status, 409);
  const home = await call(phone.base, 'GET', '/api/theater');
  assert.equal(home.json.live, null);
  assert.equal(home.json.past.length, 1);
  assert.equal(home.json.past[0].title, 'The Quiet Harbor');
  // Her four lines; the stand-in lane writes no replies of its own.
  assert.equal(home.json.past[0].said, 4);
  assert.ok(home.json.past[0].durationSeconds >= 0);
  const reopened = await call(phone.base, 'GET', `/api/theater/nights/${nightId}`);
  assert.equal(reopened.json.talk.filter((l: any) => l.role === 'user').length, 4);
  assert.equal((await call(door.base, 'GET', '/api/internal/theater')).json.live, false);
  // A new night can start now.
  const next = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Second Feature' });
  assert.equal(next.status, 201);
});

// ── the Mouth (step 2): beats on their own ─────────────────────────────────

const { mouthTick, stopTheaterMouth, theaterMouthTicking, MOUTH_FLAG } = await import('../services/theater-mouth.js');
const { lastTheaterBeatOutcome } = await import('../services/theater-couch.js');
const { setConfig, deleteConfig } = await import('../services/db/config.js');

// A made-up second feature: an old line, a run of three ending at 1055.5,
// then a line the couch must never hear early.
const SRT2 = [
  '1', '00:15:00,000 --> 00:15:02,000', 'An old line.', '',
  '2', '00:17:30,000 --> 00:17:31,500', 'Where were you?', '',
  '3', '00:17:32,000 --> 00:17:33,500', 'Out.', '',
  '4', '00:17:34,000 --> 00:17:35,500', 'Out where?', '',
  '5', '00:17:50,000 --> 00:17:52,000', 'THE TWIN WAS REAL', '',
].join('\n');

let liveId = '';
/** The house's "now" that puts the clock at `position` (the clock runs from its last resync). */
function nowAt(position: number): number {
  const clock = getNight(liveId)!.clock;
  return clock.startedAt! + (position - clock.positionAtStart) * 1000;
}

test('the live screen: chatty and "Let them react" change mid-night, checked', async () => {
  const home = await call(phone.base, 'GET', '/api/theater');
  liveId = home.json.live.night.id;
  assert.equal(home.json.live.night.mouthOn, true, 'on by default');
  assert.equal(home.json.live.mouth.houseOn, true);
  assert.equal(home.json.live.mouth.armed, false, 'no subtitles and not playing yet');
  assert.equal((await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, {})).status, 400);
  assert.equal((await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { chatty: 'loud' })).status, 400);
  assert.equal((await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { mouthOn: 'yes' })).status, 400);
  const changed = await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { chatty: 140, mouthOn: false });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.night.chatty, 100);
  assert.equal(changed.json.night.mouthOn, false);
  assert.ok(!('beatTimes' in changed.json.night) && !('lastBeatPosition' in changed.json.night));
  const back = await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { chatty: 50, mouthOn: true });
  assert.equal(back.json.night.chatty, 50);
  assert.equal(back.json.night.mouthOn, true);
});

test('finding subtitles with no OpenSubtitles key says so and leaves the night usable', async () => {
  delete process.env.OPENSUBTITLES_API_KEY;
  const found = await call(phone.base, 'POST', `/api/theater/nights/${liveId}/subtitles/find`, {});
  assert.equal(found.status, 503);
  assert.match(found.json.error, /OpenSubtitles API key/);
  const home = await call(phone.base, 'GET', '/api/theater');
  assert.equal(home.json.live.night.status, 'live');
  assert.equal(home.json.live.night.subtitleSearched, true);
  assert.equal(home.json.live.night.subtitleSource, null);
  assert.equal(home.json.live.night.subtitleOthers, null);
  assert.ok(!('subtitleCandidates' in home.json.live.night) && !('subtitleTried' in home.json.live.night));
});

test('the Mouth arms when the show plays with subtitles, and stops on pause', async () => {
  assert.equal((await uploadSubs(phone.base, liveId, 'second.srt', SRT2)).status, 200);
  const playing = await call(phone.base, 'POST', `/api/theater/nights/${liveId}/clock`, { action: 'resync', position: 1000, playing: true });
  assert.equal(playing.json.mouth.armed, true, "they're watching");
  assert.equal(theaterMouthTicking(), true);
  const paused = await call(phone.base, 'POST', `/api/theater/nights/${liveId}/clock`, { action: 'pause' });
  assert.equal(paused.json.mouth.armed, false);
  assert.equal(theaterMouthTicking(), false);
  stopTheaterMouth();
});

test('a night with her own subtitles is not looked up again', async () => {
  const found = await call(phone.base, 'POST', `/api/theater/nights/${liveId}/subtitles/find`, {});
  assert.equal(found.status, 200);
  assert.equal(found.json.night.subtitleName, 'second.srt');
  assert.equal(found.json.night.subtitleSource, 'upload');
  stopTheaterMouth();
});

test('the skip rules hold in the house: paused, off for the night, house flag off, a turn running, her line', async () => {
  laneCalls.length = 0;
  assert.equal(mouthTick(lane), 'paused');
  await call(phone.base, 'POST', `/api/theater/nights/${liveId}/clock`, { action: 'resync', position: 1000, playing: true });
  stopTheaterMouth(); // the test drives the ticks itself
  const beatAt = nowAt(1060);

  await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { mouthOn: false });
  stopTheaterMouth();
  assert.equal(mouthTick(lane, theaterDir(), beatAt), 'mouth-off');
  await call(phone.base, 'PATCH', `/api/theater/nights/${liveId}`, { mouthOn: true });
  stopTheaterMouth();

  setConfig(MOUTH_FLAG, 'false');
  try {
    assert.equal(mouthTick(lane, theaterDir(), beatAt), 'house-off');
    const view = await call(phone.base, 'GET', `/api/theater/nights/${liveId}`);
    assert.deepEqual(view.json.mouth, { houseOn: false, armed: false });
    // Couch lines keep working with the Mouth off.
    const said = await call(phone.base, 'POST', `/api/theater/nights/${liveId}/say`, { text: 'who is that' });
    assert.equal(said.status, 201);
    await theaterTurnsIdle();
    assert.equal(laneCalls.length, 1);
    assert.match(laneCalls[0].prompt, /said something on the couch/);
  } finally {
    deleteConfig(MOUTH_FLAG);
  }

  // Her line was just now: it's the conversation, the Mouth waits.
  assert.equal(mouthTick(lane, theaterDir(), Date.now() + 1000), 'she-spoke');

  // A turn on the chain: no beat queues behind it.
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  await call(phone.base, 'POST', `/api/theater/nights/${liveId}/say`, { text: 'wait what' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mouthTick(lane, theaterDir(), beatAt), 'turn-running');
  hold = null;
  release();
  await theaterTurnsIdle();
  assert.equal(laneCalls.length, 2, 'no beat was queued');
});

test('a beat: only what has played, may pass with [SILENT] and posts nothing, then cools down', async () => {
  laneCalls.length = 0;
  reply = '[SILENT]';
  const before = getNight(liveId)!;
  const talkBefore = (await call(phone.base, 'GET', `/api/theater/nights/${liveId}`)).json.talk.length;
  const beatAt = nowAt(1060);
  assert.ok(beatAt - Date.now() > 45_000, 'her last line is more than 45 s behind this moment');
  assert.equal(mouthTick(lane, theaterDir(), nowAt(1052.5)), 'no-beat', 'mid-run is not a beat');
  assert.equal(mouthTick(lane, theaterDir(), beatAt), 'run-then-gap');
  await theaterTurnsIdle();
  assert.equal(laneCalls.length, 1);
  const { prompt, threadId } = laneCalls[0];
  assert.equal(threadId, before.threadId);
  assert.match(prompt, /a moment in the show/);
  assert.match(prompt, /Where were you\?[\s\S]*Out\.[\s\S]*Out where\?/);
  assert.match(prompt, /exactly \[SILENT\]/);
  assert.match(prompt, /never reveal what's coming, even if you know this show/);
  assert.doesNotMatch(prompt, /TWIN/, 'never a line after the clock');
  assert.doesNotMatch(prompt, /An old line/, 'older than the lookback window');
  assert.equal(lastTheaterBeatOutcome(), 'passed');
  const after = await call(phone.base, 'GET', `/api/theater/nights/${liveId}`);
  assert.equal(after.json.talk.length, talkBefore, 'a pass posts nothing on the couch');
  assert.equal(after.json.night.turn.state, before.turn.state, 'a beat never shows "waiting" or "try again"');
  const night = getNight(liveId)!;
  assert.equal(Math.round(night.lastBeatPosition!), 1060);
  assert.equal(night.beatTimes!.length, 1);

  // Straight after: cooling down, whatever the show does.
  assert.equal(mouthTick(lane, theaterDir(), beatAt + 5000), 'cooldown');
  assert.equal(laneCalls.length, 1);
});

test('a failed beat is not retried', async () => {
  laneCalls.length = 0;
  reply = new Error('the line dropped');
  // Clear the cooldown and give it a fresh run: the last beat moved back, none this hour.
  const night = getNight(liveId)!;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(theaterDir(), 'nights', `${liveId}.json`), JSON.stringify({ ...night, lastBeatPosition: 1040, beatTimes: [] }));
  const beatAt = nowAt(1060);
  assert.equal(mouthTick(lane, theaterDir(), beatAt), 'run-then-gap');
  await theaterTurnsIdle();
  assert.equal(lastTheaterBeatOutcome(), 'failed');
  assert.equal(getNight(liveId)!.turn.state, 'idle', "a failed beat doesn't ask her to say it again");
  assert.equal(mouthTick(lane, theaterDir(), beatAt + 5000), 'cooldown');
  await theaterTurnsIdle();
  assert.equal(laneCalls.length, 1, 'tried once');
  reply = 'couch talk';
  stopTheaterMouth();
});

// ── the start form finds subtitles (stand-in OpenSubtitles, no network) ────

test('the start form searches as she types, and Start downloads that match onto the night', async () => {
  const { clearSubtitleSearchCache } = await import('../services/theater-subs-fetch.js');
  clearSubtitleSearchCache();
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  let quota = false;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    outside.push(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/subtitles?')) {
      if (url.includes('query=nothing')) return json(200, { data: [] });
      return json(200, {
        data: [7, 8].map((n) => ({
          attributes: {
            language: 'en', download_count: 100 - n, release: `HDTV.Cut${n}`,
            feature_details: { feature_type: 'Episode', parent_title: 'The Quiet Harbor', season_number: 2, episode_number: 7 },
            files: [{ file_id: 700 + n, file_name: `cut${n}.srt` }],
          },
        })),
      });
    }
    if (url.endsWith('/download')) {
      if (quota) return json(406, { message: 'quota', remaining: 0 });
      return json(200, { link: `https://dl.example.test/${JSON.parse(String(init?.body)).file_id}`, remaining: 3 });
    }
    if (url.startsWith('https://dl.example.test/')) return new Response(SRT2, { status: 200 });
    return json(404, {});
  }) as typeof fetch;
  setSecret('opensubtitles_api_key', 'test-key-not-real');
  try {
    await call(phone.base, 'POST', `/api/theater/nights/${liveId}/end`);
    stopTheaterMouth();

    const found = await call(phone.base, 'GET', '/api/theater/subtitles/search?title=The%20Quiet%20Harbor&season=2&episode=7');
    assert.equal(found.status, 200);
    assert.deepEqual(found.json, { best: { fileId: 707, label: 'The Quiet Harbor S02E07 · HDTV.Cut7', release: 'HDTV.Cut7' }, count: 2 });
    assert.equal(JSON.stringify(found.json).includes('test-key'), false, 'the key never reaches the phone');
    const none = await call(phone.base, 'GET', '/api/theater/subtitles/search?title=Nothing');
    assert.deepEqual(none.json, { best: null, count: 0 });
    assert.equal((await call(phone.base, 'GET', '/api/theater/subtitles/search?title=X&season=2')).status, 400);
    assert.equal(outside.filter((u) => u.endsWith('/download')).length, 0, 'searching downloads nothing');

    const started = await call(phone.base, 'POST', '/api/theater/nights', { title: 'The Quiet Harbor', season: 2, episode: 7, subtitleFileId: 707 });
    assert.equal(started.status, 201);
    assert.equal(started.json.subtitleError, null);
    assert.equal(started.json.night.subtitleName, 'HDTV.Cut7');
    assert.equal(started.json.night.subtitleSource, 'opensubtitles');
    assert.equal(started.json.night.cueCount, 5);
    assert.equal(started.json.night.subtitleOthers, 1);
    assert.equal(outside.filter((u) => u.includes('/subtitles?')).length, 2, "Start reuses the form's search");
    assert.equal(outside.filter((u) => u.endsWith('/download')).length, 1);
    const id = started.json.night.id;

    // Try another on the live night; asking plainly again never re-downloads.
    const other = await call(phone.base, 'POST', `/api/theater/nights/${id}/subtitles/find`, { another: true });
    assert.equal(other.json.night.subtitleName, 'HDTV.Cut8');
    await call(phone.base, 'POST', `/api/theater/nights/${id}/subtitles/find`, {});
    assert.equal(outside.filter((u) => u.endsWith('/download')).length, 2);
    await call(phone.base, 'POST', `/api/theater/nights/${id}/end`);
    stopTheaterMouth();

    // Out of downloads at Start: the night still starts and says why.
    quota = true;
    const capped = await call(phone.base, 'POST', '/api/theater/nights', { title: 'The Quiet Harbor', season: 2, episode: 7, subtitleFileId: 707 });
    assert.equal(capped.status, 201);
    assert.equal(capped.json.night.status, 'live');
    assert.equal(capped.json.night.cueCount, 0);
    assert.equal(capped.json.subtitleError, 'Out of subtitle downloads for today — load a file instead.');
    // No match chosen: Start downloads nothing.
    await call(phone.base, 'POST', `/api/theater/nights/${capped.json.night.id}/end`);
    const before = outside.length;
    const plain = await call(phone.base, 'POST', '/api/theater/nights', { title: 'Nothing' });
    assert.equal(plain.status, 201);
    assert.equal(outside.length, before);
  } finally {
    globalThis.fetch = realFetch;
    deleteSecret('opensubtitles_api_key');
    stopTheaterMouth();
  }
});
