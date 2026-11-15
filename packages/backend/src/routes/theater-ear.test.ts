// The Theater's Ear: pairing (one-time code → token), the Ear's bearer door,
// heard lines becoming cues, the clock following the video, the probe, and a
// computer night on the start form and through "next one". No network: any
// outside fetch is counted and refused. Titles and lines are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'theater-ear-test-'));
process.env.RESONANT_HOME = tmpRoot;
process.env.DB_PATH = join(tmpRoot, 'bytelight.db');
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { getConfig } = await import('../services/db/config.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { createEarRoutes } = await import('./theater-ear.js');
const { getNight, theaterDir } = await import('../services/theater.js');
const ear = await import('../services/theater-ear.js');
const { mouthTick, stopTheaterMouth, theaterMouthTicking } = await import('../services/theater-mouth.js');
const { theaterTurnsIdle } = await import('../services/theater-couch.js');
const { LOCAL_COMPANION_ID } = await import('../services/agent.js');
const theaterRoutes = (await import('./theater.js')).default;

initDb(':memory:');
getDb().prepare('DELETE FROM companions').run();
for (const [slug, name] of [['companion-a', 'Companion A'], ['companion-b', 'Companion B']]) {
  getDb().prepare('INSERT INTO companions (id, display_name, brain) VALUES (?, ?, ?)').run(slug, name, LOCAL_COMPANION_ID);
}

const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  outside.push(url);
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function listen(app: express.Express): Promise<{ base: string }> {
  const server = app.listen(0, '127.0.0.1');
  server.unref();
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

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

const laneCalls: string[] = [];
const lane = { async processMessage(_t: string, prompt: string): Promise<string> { laneCalls.push(prompt); return '[SILENT]'; } };

// The house as api.ts lays it out: the Ear's door before the session wall, her door behind it.
const house = express();
house.use(express.json({ limit: '10mb' }));
house.locals.agentService = lane;
house.use('/api/theater-ear', createEarRoutes({ perMinute: 100_000, claimsPer15Min: 100_000 }));
house.use('/api', (req, res, next) => (req.headers['x-test-session'] === 'yes' ? next() : res.status(401).json({ error: 'auth' })));
house.use('/api/theater', theaterRoutes);
const { base } = await listen(house);

const internalApp = express();
internalApp.use(express.json());
internalApp.locals.agentService = lane;
internalApp.use('/api', createInternalRoutes());
const door = await listen(internalApp);

const SESSION = { 'x-test-session': 'yes' };
const her = (method: string, path: string, body?: unknown) => call(base, method, `/api/theater${path}`, body, SESSION);
let token = '';
const earCall = (method: string, path: string, body?: unknown, t = token) =>
  call(base, method, `/api/theater-ear${path}`, body, t ? { authorization: `Bearer ${t}` } : {});

test.after(() => {
  globalThis.fetch = realFetch;
  stopTheaterMouth();
});

test('a pairing code: 8 easy characters, 10 minutes, one use; wrong guesses burn it', () => {
  const t0 = 1_800_000_000_000;
  const { code, expiresAt } = ear.createPairingCode(t0);
  assert.equal(code.length, 8);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(Date.parse(expiresAt), t0 + 10 * 60_000);
  assert.ok(!getConfig(ear.EAR_KEYS.pairing)!.includes(code), 'only the hash of the code is kept');

  // Expired: refused, and gone.
  assert.throws(() => ear.claimPairingCode(code, t0 + 10 * 60_000 + 1), /did not work/);
  assert.equal(getConfig(ear.EAR_KEYS.pairing), null);

  // Single use, typed loosely (lowercase, a dash) still counts.
  const fresh = ear.createPairingCode(t0).code;
  const loose = `${fresh.slice(0, 4).toLowerCase()}-${fresh.slice(4)}`;
  const { token: first } = ear.claimPairingCode(loose, t0 + 1000);
  assert.ok(first.length >= 40);
  assert.equal(getConfig(ear.EAR_KEYS.tokenHash)!.length, 64, 'only the token hash is kept');
  assert.ok(!getConfig(ear.EAR_KEYS.tokenHash)!.includes(first));
  assert.ok(ear.earTokenValid(first));
  assert.throws(() => ear.claimPairingCode(fresh, t0 + 2000), /did not work/);

  // Ten wrong guesses and the waiting code is burned, right one included.
  const target = ear.createPairingCode(t0).code;
  for (let i = 0; i < ear.PAIRING_MAX_MISSES; i++) assert.throws(() => ear.claimPairingCode('WRONGWRO', t0 + 1000));
  assert.throws(() => ear.claimPairingCode(target, t0 + 1000), /did not work/);
  ear.revokeEar();
  assert.equal(ear.earTokenValid(first), false);
});

test('the Wire: she makes a code behind her session, the Ear trades it for a token at the open claim door', async () => {
  assert.equal((await call(base, 'POST', '/api/theater/ear/pair')).status, 401, 'making a code needs her session');
  let view = await her('GET', '/ear');
  assert.equal(view.json.paired, false);

  const made = await her('POST', '/ear/pair');
  assert.equal(made.status, 201);
  assert.equal(made.json.code.length, 8);
  assert.ok(made.json.ear.codeWaitingUntil);

  assert.equal((await earCall('POST', '/claim', { code: 'NOTACODE' }, '')).status, 401);
  const claimed = await earCall('POST', '/claim', { code: made.json.code }, '');
  assert.equal(claimed.status, 201);
  token = claimed.json.token;
  assert.equal((await earCall('POST', '/claim', { code: made.json.code }, '')).status, 401, 'the code is spent');

  view = await her('GET', '/ear');
  assert.equal(view.json.paired, true);
  assert.equal(view.json.codeWaitingUntil, null);
});

test('the Ear door wants its bearer token; a wrong one is refused; only its own routes answer', async () => {
  assert.equal((await earCall('GET', '/status', undefined, '')).status, 401);
  assert.equal((await earCall('GET', '/status', undefined, 'x'.repeat(43))).status, 401);
  assert.equal((await call(base, 'GET', '/api/theater-ear/status', undefined, { authorization: token })).status, 401, 'Bearer prefix needed');
  const ok = await earCall('GET', '/status');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { live: false, night: null });
  assert.equal((await earCall('GET', '/nights')).status, 404);
  assert.equal((await earCall('POST', '/say', { text: 'hi' })).status, 404);
  assert.equal((await earCall('GET', '/../theater')).status, 401, 'her door is not reachable with the Ear token');
});

let tvId = '';
let pcId = '';

test('a TV night is not the Ear\'s: status says not live, lines and clock are refused', async () => {
  const tv = await her('POST', '/nights', { title: 'The Quiet Harbor', season: 1, episode: 1 });
  assert.equal(tv.status, 201);
  tvId = tv.json.night.id;
  assert.equal(tv.json.night.mode, 'tv');
  assert.equal(tv.json.ear, null);
  assert.equal((await earCall('GET', '/status')).json.live, false);
  assert.equal((await earCall('POST', '/lines', { lines: [{ text: 'Hello.', start: 1, end: 2 }] })).status, 409);
  assert.equal((await earCall('POST', '/clock', { position: 5, paused: false })).status, 409);
  assert.equal(getNight(tvId)!.cues.length, 0);
  await her('POST', `/nights/${tvId}/end`);
});

test('the start form: "On the computer" starts a night with no subtitle download, and shows the Ear waiting', async () => {
  const before = outside.length;
  const started = await her('POST', '/nights', { title: 'The Quiet Harbor', season: 2, episode: 4, mode: 'computer', chatty: 100, subtitleFileId: 1234 });
  assert.equal(started.status, 201);
  pcId = started.json.night.id;
  assert.equal(started.json.night.mode, 'computer');
  assert.equal(started.json.night.cueCount, 0);
  assert.equal(outside.length, before, 'nothing went looking for subtitles');
  assert.equal(started.json.ear.paired, true);
  assert.equal(started.json.ear.lastLine, null);

  // No files and no searches on a computer night.
  assert.equal((await her('POST', `/nights/${pcId}/subtitles/find`, {})).status, 409);
  const form = new FormData();
  form.append('file', new Blob(['1\n00:00:01,000 --> 00:00:02,000\nHi\n'], { type: 'application/x-subrip' }), 'x.srt');
  const up = await realFetch(`${base}/api/theater/nights/${pcId}/subtitles`, { method: 'POST', body: form, headers: SESSION });
  assert.equal(up.status, 409);
  assert.equal(outside.length, before);

  const status = await earCall('GET', '/status');
  assert.deepEqual(status.json, { live: true, night: { id: pcId, title: 'The Quiet Harbor', season: 2, episode: 4 } });
});

test('heard lines append in order, the same words within 2 s are one line, and only onto the live computer night', async () => {
  const res = await earCall('POST', '/lines', {
    nightId: pcId,
    lines: [
      { text: '  Who left\n the   gate open? ', start: 12, end: 14 },
      { text: 'Not me.', start: 15, end: 16.5 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.added, 2);
  // A rewind brings an earlier line late; a repeat of a kept line is dropped.
  const again = await earCall('POST', '/lines', {
    lines: [
      { text: 'Not me.', start: 16, end: 17 },
      { text: 'It was open all night.', start: 18, end: 20 },
      { text: 'Earlier words.', start: 5, end: 6 },
    ],
  });
  assert.equal(again.json.added, 2);
  const cues = getNight(pcId)!.cues;
  assert.deepEqual(cues.map((c) => c.text), ['Earlier words.', 'Who left\nthe gate open?', 'Not me.', 'It was open all night.']);
  assert.deepEqual(cues.map((c) => c.start), [5, 12, 15, 18]);

  // The same words far apart are two lines (a catchphrase said twice).
  assert.equal((await earCall('POST', '/lines', { lines: [{ text: 'Not me.', start: 300, end: 301 }] })).json.added, 1);

  // Checked: a stale night id, a bad line, too many lines, too big a body.
  assert.equal((await earCall('POST', '/lines', { nightId: tvId, lines: [{ text: 'x', start: 1, end: 2 }] })).status, 409);
  assert.equal((await earCall('POST', '/lines', { lines: [{ text: '', start: 1 }] })).status, 400);
  assert.equal((await earCall('POST', '/lines', { lines: [{ text: 'x', start: -1 }] })).status, 400);
  assert.equal((await earCall('POST', '/lines', { lines: 'nope' })).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => ({ text: `line ${i}`, start: 400 + i, end: 401 + i }));
  assert.equal((await earCall('POST', '/lines', { lines: many })).status, 413);
  const big = Array.from({ length: 40 }, (_, i) => ({ text: 'y'.repeat(990), start: 500 + i, end: 501 + i }));
  assert.equal((await earCall('POST', '/lines', { lines: big })).status, 413);
  assert.equal(getNight(pcId)!.cues.length, 5);

  const view = await her('GET', `/nights/${pcId}`);
  assert.equal(view.json.ear.lastLine, 'Not me.');
  assert.equal(view.json.ear.listening, true);
  assert.equal(view.json.night.subtitleSource, 'ear');
});

test('clock reports move the clock, arm the Mouth, and the couch hears Ear lines only up to the clock', async () => {
  // Paused at 13 s: nothing after 13 s is heard.
  let res = await earCall('POST', '/clock', { nightId: pcId, position: 13, paused: true, duration: 2700 });
  assert.equal(res.status, 200);
  let night = getNight(pcId)!;
  assert.equal(night.clock.paused, true);
  assert.equal(night.clock.positionAtStart, 13);
  assert.equal(night.ear?.duration, 2700);
  assert.equal(theaterMouthTicking(), false);
  let couch = await call(door.base, 'GET', '/api/internal/theater');
  assert.deepEqual(couch.json.lookback.map((c: any) => c.text), ['Earlier words.', 'Who left\nthe gate open?']);

  // Playing at 10 s: the Mouth listens.
  res = await earCall('POST', '/clock', { position: 10, paused: false });
  assert.equal(res.json.paused, false);
  assert.equal(theaterMouthTicking(), true);
  const phone = await her('GET', `/nights/${pcId}`);
  assert.equal(phone.json.mouth.armed, true);
  night = getNight(pcId)!;
  assert.equal(night.clock.paused, false);

  // The Mouth's first look marks where she is; at 25 s, after a run of three lines and a quiet gap, it's a beat.
  const now = Date.now();
  assert.equal(mouthTick(lane, theaterDir(), now, pcId), 'no-beat');
  await earCall('POST', '/clock', { position: 25, paused: false });
  assert.equal(mouthTick(lane, theaterDir(), Date.now(), pcId), 'run-then-gap');
  await theaterTurnsIdle();
  const prompt = laneCalls.at(-1)!;
  assert.match(prompt, /a moment in the show/);
  assert.match(prompt, /on her computer/);
  assert.match(prompt, /It was open all night\./);
  assert.doesNotMatch(prompt, /\[00:05:00\]/, 'a line after the clock never reaches the couch');

  // Checked input.
  assert.equal((await earCall('POST', '/clock', { position: 'soon', paused: false })).status, 400);
  assert.equal((await earCall('POST', '/clock', { position: 5 })).status, 400);
  assert.equal((await earCall('POST', '/clock', { position: 5, paused: true, nightId: tvId })).status, 409);
});

test('the probe is kept in one file, overwritten, and capped', async () => {
  const path = join(theaterDir(), 'ear-probe.json');
  let res = await earCall('POST', '/probe', { site: 'hulu', path: '/watch/abc', video: true, candidates: [{ tag: 'div', className: 'CaptionBox', text: 'Hi' }] });
  assert.equal(res.status, 201);
  assert.ok(existsSync(path));
  let kept = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(kept.probe.site, 'hulu');
  assert.ok(kept.receivedAt);
  res = await earCall('POST', '/probe', { site: 'netflix', path: '/watch/1', video: false, candidates: [] });
  kept = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(kept.probe.site, 'netflix', 'overwritten');
  assert.equal((await earCall('POST', '/probe', { junk: 'z'.repeat(70 * 1024) })).status, 413);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).probe.site, 'netflix', 'a refused probe leaves the last one');
  assert.equal((await earCall('POST', '/probe', [1, 2])).status, 400);
  assert.equal((await earCall('POST', '/probe', { site: 'x' }, '')).status, 401);
});

test('next one on a computer night starts another computer night, no subtitle search', async () => {
  const before = outside.length;
  const res = await call(door.base, 'POST', `/api/internal/theater/nights/${pcId}/next`);
  assert.equal(res.status, 200);
  assert.equal(res.json.night.mode, 'computer');
  assert.equal(res.json.night.episode, 5);
  assert.equal(res.json.night.chatty, 100);
  assert.equal(res.json.subtitles.loaded, false);
  assert.match(res.json.note, /on the computer/);
  assert.equal(outside.length, before, 'nothing went looking for subtitles');
  // The Ear follows: status names the new night, and lines for the old one are refused.
  const status = await earCall('GET', '/status');
  assert.equal(status.json.night.id, res.json.night.id);
  assert.equal((await earCall('POST', '/lines', { nightId: pcId, lines: [{ text: 'Old.', start: 1, end: 2 }] })).status, 409);
  pcId = res.json.night.id;
});

test('disconnecting the Ear revokes its token at once', async () => {
  const res = await her('POST', '/ear/disconnect');
  assert.equal(res.json.paired, false);
  assert.equal((await earCall('GET', '/status')).status, 401);
  assert.equal((await earCall('POST', '/lines', { lines: [{ text: 'Hi.', start: 1, end: 2 }] })).status, 401);
  assert.equal(getConfig(ear.EAR_KEYS.tokenHash), null);
  await her('POST', `/nights/${pcId}/end`);
});

test('the claim door is rate limited', async () => {
  const strict = express();
  strict.use(express.json());
  strict.use('/api/theater-ear', createEarRoutes({ claimsPer15Min: 2 }));
  const s = await listen(strict);
  const claim = () => call(s.base, 'POST', '/api/theater-ear/claim', { code: 'AAAAAAAA' });
  assert.equal((await claim()).status, 401);
  assert.equal((await claim()).status, 401);
  assert.equal((await claim()).status, 429);
});
