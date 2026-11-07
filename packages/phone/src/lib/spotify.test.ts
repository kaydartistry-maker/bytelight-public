// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify, for seeing: what the phone decides about each answer, with the
// house replaced by a fake that answers the way each backend really would.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTART_LINE,
  SIGNED_OUT_LINE,
  UNREACHABLE_LINE,
  largerCover,
  loadSpotifyHome,
  loadSpotifyPlaylist,
  recentRow,
  songCount,
  troubleLine,
  wholeAppTrouble,
  PRESS_SETTLE_MS,
  playableSong,
  playingUri,
  playlistUriOf,
  pressAndLook,
  pressShows,
  sendPress,
  searchSpotify,
  songPress,
  type SpotifyPress,
} from './spotify';
import type { SpotifyNowView } from '@bytelight/shared';
import { createSpotifyNow } from './spotify';

const PAGE = '<!doctype html><html><head><title>byte-light</title></head><body><div id="root"></div></body></html>';
const html = () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const NOW = { playing: true, track: { name: 'Beauty', artist: 'Layto', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', cover: 'https://i.scdn.co/image/ab67616d00001e02beauty', album: null } };
const RECENT = { tracks: [{ name: 'MY HEAD', artist: 'Layto', uri: 'spotify:track:7q', cover: null, playedAt: '2026-10-20T00:17:27.554Z' }] };
const LISTS = { playlists: [{ id: '1AbCdEfGhIjKlMnOpQrStU', name: 'Sunday Mix', tracks: 5, uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU', cover: 'https://mosaic.scdn.co/300/x' }] };

/** A house: each address answers what this backend would. */
function house(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (url: string) => {
      asked.push(url);
      const answer = answers[url];
      if (!answer) throw new TypeError('Failed to fetch');
      return answer();
    },
  };
}

test('the new house: all three reads land as they are', async () => {
  const { fetcher, asked } = house({ '/api/spotify/now': () => json(NOW), '/api/spotify/recent': () => json(RECENT), '/api/spotify/playlists': () => json(LISTS) });
  const home = await loadSpotifyHome(fetcher);
  assert.deepEqual(home, { now: { ok: true, data: NOW }, recent: { ok: true, data: RECENT }, playlists: { ok: true, data: LISTS } });
  assert.equal(wholeAppTrouble(home), null);
  assert.deepEqual(asked.sort(), ['/api/spotify/now', '/api/spotify/playlists', '/api/spotify/recent']);
});

test('the old house answers with the phone\'s own page, 200 and HTML, and that asks for a restart, once', async () => {
  const { fetcher } = house({ '/api/spotify/now': html, '/api/spotify/recent': html, '/api/spotify/playlists': html });
  const home = await loadSpotifyHome(fetcher);
  assert.deepEqual(home.now, { ok: false, trouble: { kind: 'restart' } });
  const whole = wholeAppTrouble(home);
  assert.deepEqual(whole, { kind: 'restart' });
  assert.equal(troubleLine(whole!), 'Spotify needs the house restarted once.');
  assert.equal(RESTART_LINE, 'Spotify needs the house restarted once.');

  const odd = house({ '/api/spotify/playlists/abc': () => json({ something: 'else' }) });
  assert.deepEqual(await loadSpotifyPlaylist(odd.fetcher, 'abc'), { ok: false, trouble: { kind: 'restart' } },
    'JSON that is not the expected shape is not trusted either');
});

test('a lapsed sign-in is said once, in the house\'s sentence, with its sign-in page', async () => {
  const lapsed = () => json({ error: 'Lapsed, in a sentence.', reason: 'signin', authUrl: 'https://example.workers.dev/auth' }, 502);
  const { fetcher } = house({ '/api/spotify/now': lapsed, '/api/spotify/recent': lapsed, '/api/spotify/playlists': lapsed });
  const whole = wholeAppTrouble(await loadSpotifyHome(fetcher));
  assert.deepEqual(whole, { kind: 'signin', message: 'Lapsed, in a sentence.', authUrl: 'https://example.workers.dev/auth' });
  const once = house({ '/api/spotify/now': lapsed, '/api/spotify/recent': () => json(RECENT), '/api/spotify/playlists': () => json(LISTS) });
  assert.equal(wholeAppTrouble(await loadSpotifyHome(once.fetcher))?.kind, 'signin', 'even one lapsed read is the whole news');
});

test('one section that fails says so in its own place, and the others still show', async () => {
  const { fetcher } = house({
    '/api/spotify/now': () => json({ error: 'Spotify answered with an error: Rate limited.', reason: 'spotify' }, 502),
    '/api/spotify/recent': () => json(RECENT),
    '/api/spotify/playlists': () => json(LISTS),
  });
  const home = await loadSpotifyHome(fetcher);
  assert.equal(wholeAppTrouble(home), null);
  assert.deepEqual(home.now, { ok: false, trouble: { kind: 'problem', message: 'Spotify answered with an error: Rate limited.' } });

  const down = house({});
  const gone = await loadSpotifyHome(down.fetcher);
  assert.deepEqual(wholeAppTrouble(gone), { kind: 'problem', message: UNREACHABLE_LINE }, 'all three failing stands in for the page');

  const out = house({ '/api/spotify/playlists/abc': () => json({ error: 'Unauthorized' }, 401) });
  assert.deepEqual(await loadSpotifyPlaylist(out.fetcher, 'abc'), { ok: false, trouble: { kind: 'problem', message: SIGNED_OUT_LINE } });

  const gateway = house({ '/api/spotify/playlists/abc': () => new Response('<html>502</html>', { status: 502 }) });
  assert.deepEqual(await loadSpotifyPlaylist(gateway.fetcher, 'abc'), { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } });
});

test('a playlist id is sent as one path piece', async () => {
  const { fetcher, asked } = house({});
  await loadSpotifyPlaylist(fetcher, 'a/b?c');
  assert.deepEqual(asked, ['/api/spotify/playlists/a%2Fb%3Fc']);
});

test('the words and pictures: song counts, each recent song once, and the big cover', () => {
  assert.equal(songCount(1), '1 song');
  assert.equal(songCount(23), '23 songs');
  assert.equal(songCount(0), '0 songs');
  assert.equal(songCount(null), '');
  const a = { name: 'A', artist: 'X', uri: 'spotify:track:a', cover: null, playedAt: '3' };
  const b = { name: 'B', artist: 'X', uri: 'spotify:track:b', cover: null, playedAt: '2' };
  assert.deepEqual(recentRow([a, b, { ...a, playedAt: '1' }]).map((t) => t.playedAt), ['3', '2'], 'a song played twice shows once, at its newest play');
  assert.equal(largerCover('https://i.scdn.co/image/ab67616d00001e0221b700e6f5ecf4b11c14fc56'), 'https://i.scdn.co/image/ab67616d0000b27321b700e6f5ecf4b11c14fc56');
  assert.equal(largerCover('https://mosaic.scdn.co/300/abc'), null, 'a mosaic is not resized');
  assert.equal(largerCover(null), null);
});

// ─── Playing ─────────────────────────────────────────────────────────

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const OTHER = 'spotify:track:463ahmflVo5cjEewhhbgAJ';
const WEDDING = 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU';
const NOWHERE = 'Open Spotify on your phone first, then try again.';
const UNSURE = "Spotify's server could not tell whether that worked.";
const playingNow = (uri: string | null, playing = true): SpotifyNowView =>
  ({ playing, track: uri ? { name: 'A song', artist: 'Layto', uri, cover: null, album: null } : null });

/** A house for presses: each address answers from its own list, in turn, and every ask is kept. */
function pressHouse(answers: Record<string, Array<() => Response>>) {
  const asked: Array<{ url: string; method: string; body: unknown }> = [];
  return {
    asked,
    fetcher: async (url: string, init?: RequestInit) => {
      asked.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const next = answers[url]?.shift();
      if (!next) throw new TypeError('Failed to fetch');
      return next();
    },
  };
}

test('each press goes to the house once, to its own address, with only what it needs', async () => {
  const presses: Array<[SpotifyPress, string, unknown]> = [
    [{ kind: 'song', uri: SONG }, '/api/spotify/play', { trackUri: SONG }],
    [{ kind: 'playlist', uri: WEDDING, songs: null }, '/api/spotify/play', { playlistUri: WEDDING }],
    [{ kind: 'resume' }, '/api/spotify/play', {}],
    [{ kind: 'pause' }, '/api/spotify/pause', {}],
    [{ kind: 'next' }, '/api/spotify/skip', { direction: 'next' }],
    [{ kind: 'previous' }, '/api/spotify/skip', { direction: 'previous' }],
  ];
  for (const [press, url, body] of presses) {
    const { fetcher, asked } = pressHouse({ [url]: [() => json({ ok: true })] });
    assert.deepEqual(await sendPress(fetcher, press), { ok: true }, `${press.kind} is taken`);
    assert.deepEqual(asked, [{ url, method: 'POST', body }], `${press.kind} asks ${url} once, with ${JSON.stringify(body)}`);
  }
});

test('the old house has no address for a press, and that asks for a restart', async () => {
  const cannotPost = () => new Response('<!DOCTYPE html><html><body><pre>Cannot POST /api/spotify/play</pre></body></html>',
    { status: 404, headers: { 'content-type': 'text/html' } });
  const old = pressHouse({ '/api/spotify/play': [cannotPost, html, () => json({ ok: 'yes' })] });
  for (const what of ["Express's own 404 page", "the phone's own page", 'JSON that is not a yes']) {
    assert.deepEqual(await sendPress(old.fetcher, { kind: 'song', uri: SONG }), { ok: false, trouble: { kind: 'restart' } }, `${what} asks for a restart`);
  }
  assert.equal(troubleLine({ kind: 'restart' }), RESTART_LINE, 'in the line the app already uses');
  const down = pressHouse({});
  assert.deepEqual(await sendPress(down.fetcher, { kind: 'pause' }), { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } },
    'no house at all could not be reached');
  const out = pressHouse({ '/api/spotify/pause': [() => json({ error: 'Unauthorized' }, 401)] });
  assert.deepEqual(await sendPress(out.fetcher, { kind: 'pause' }), { ok: false, trouble: { kind: 'problem', message: SIGNED_OUT_LINE } },
    'a lapsed session asks the owner to sign in');
  const gateway = pressHouse({ '/api/spotify/pause': [() => new Response('<html>502</html>', { status: 502 })] });
  assert.deepEqual(await sendPress(gateway.fetcher, { kind: 'pause' }), { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } },
    'a page from in front of a house that is down');
});

test("a press the house refuses comes back in the house's own sentence", async () => {
  const house = pressHouse({ '/api/spotify/play': [
    () => json({ error: NOWHERE, reason: 'device' }, 409),
    () => json({ error: 'Lapsed, in a sentence.', reason: 'signin', authUrl: 'https://example.workers.dev/auth' }, 502),
    () => json({ error: 'That is not a Spotify song.', reason: 'spotify' }, 400),
    () => json({ error: 'Internal server error' }, 500),
  ] });
  const play = () => sendPress(house.fetcher, { kind: 'song', uri: SONG });
  assert.deepEqual(await play(), { ok: false, trouble: { kind: 'problem', message: NOWHERE, device: true } }, 'nowhere to play, marked as the one the app can wake for');
  assert.deepEqual(await play(), { ok: false, trouble: { kind: 'signin', message: 'Lapsed, in a sentence.', authUrl: 'https://example.workers.dev/auth' } },
    'a lapsed sign-in, with its page');
  assert.deepEqual(await play(), { ok: false, trouble: { kind: 'problem', message: 'That is not a Spotify song.' } }, 'a refusal at the door');
  assert.deepEqual(await play(), { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } },
    "an error that is not one of the house's sentences is not shown as one");
});

test('after a press the phone waits a moment, looks once, and believes what it sees', async () => {
  const waits: number[] = [];
  const order: string[] = [];
  async function run(url: string, answer: () => Response, look: () => Response, press: SpotifyPress, before: SpotifyNowView | null) {
    const house = pressHouse({ [url]: [answer], '/api/spotify/now': [look] });
    const outcome = await pressAndLook(house.fetcher, press, before, {
      wait: async (ms) => { waits.push(ms); order.push(`wait after ${house.asked.length}`); },
      looking: () => { order.push(`looking after ${house.asked.length}`); },
    });
    return { outcome, asked: house.asked.map((ask) => `${ask.method} ${ask.url}`) };
  }
  const unsure = () => json({ error: UNSURE, reason: 'spotify' }, 502);

  const taken = await run('/api/spotify/play', () => json({ ok: true }), () => json(playingNow(SONG)), { kind: 'song', uri: SONG }, playingNow(OTHER));
  assert.deepEqual(taken.asked, ['POST /api/spotify/play', 'GET /api/spotify/now'], 'the press, then one look');
  assert.equal(PRESS_SETTLE_MS, 1500, 'about a second and a half');
  assert.deepEqual(waits, [PRESS_SETTLE_MS], 'one wait, between them');
  assert.deepEqual(order, ['wait after 1', 'looking after 1'], 'the wait comes after the press, and the look is told of just before it is made');
  assert.deepEqual(taken.outcome, { now: playingNow(SONG), trouble: null }, 'a taken press shows what is playing, with nothing to say');

  const worked = await run('/api/spotify/play', unsure, () => json(playingNow(SONG)), { kind: 'song', uri: SONG }, playingNow(OTHER));
  assert.deepEqual(worked.outcome, { now: playingNow(SONG), trouble: null }, 'an error from a press that worked is not shown');

  const didNot = await run('/api/spotify/skip', unsure, () => json(playingNow(OTHER)), { kind: 'next' }, playingNow(OTHER));
  assert.deepEqual(didNot.outcome, { now: playingNow(OTHER), trouble: { kind: 'problem', message: UNSURE } },
    'an error is shown when the look does not show the change');

  const nowhere = await run('/api/spotify/play', () => json({ error: NOWHERE, reason: 'device' }, 409), () => json({ playing: false, track: null }), { kind: 'resume' }, null);
  assert.deepEqual(nowhere.outcome, { now: { playing: false, track: null }, trouble: { kind: 'problem', message: NOWHERE, device: true } }, 'nowhere to play is said');

  const blind = await run('/api/spotify/pause', () => json({ ok: true }), () => new Response('<html>502</html>', { status: 502 }), { kind: 'pause' }, playingNow(SONG));
  assert.deepEqual(blind.outcome, { now: null, trouble: null }, 'a taken press whose look did not come back keeps the screen and says nothing');

  const old = await run('/api/spotify/pause', () => new Response('Cannot POST', { status: 404 }), () => json(playingNow(SONG)), { kind: 'pause' }, playingNow(SONG));
  assert.deepEqual(old.outcome, { now: playingNow(SONG), trouble: { kind: 'restart' } }, 'the old house asks for its restart');
});

test('what counts as the change the owner pressed for', () => {
  const stopped: SpotifyNowView = { playing: false, track: null };
  const cases: Array<[SpotifyPress, SpotifyNowView | null, SpotifyNowView, boolean, string]> = [
    [{ kind: 'song', uri: SONG }, playingNow(OTHER), playingNow(SONG), true, 'their song, playing'],
    [{ kind: 'song', uri: SONG }, playingNow(OTHER), playingNow(SONG, false), false, 'their song, but paused'],
    [{ kind: 'song', uri: SONG }, playingNow(OTHER), playingNow(OTHER), false, 'the song from before'],
    [{ kind: 'playlist', uri: WEDDING, songs: [OTHER, SONG] }, stopped, playingNow(SONG), true, 'a song from the playlist, playing'],
    [{ kind: 'playlist', uri: WEDDING, songs: [OTHER] }, stopped, playingNow(SONG), false, 'a song from somewhere else'],
    [{ kind: 'playlist', uri: WEDDING, songs: [SONG] }, stopped, playingNow(SONG, false), false, 'a song from the playlist, paused'],
    [{ kind: 'playlist', uri: WEDDING, songs: null }, playingNow(OTHER), playingNow(SONG), true, 'its songs unknown: something new playing'],
    [{ kind: 'playlist', uri: WEDDING, songs: null }, playingNow(SONG), playingNow(SONG), false, 'its songs unknown: the same song as before'],
    [{ kind: 'resume' }, playingNow(SONG, false), playingNow(SONG), true, 'carrying on'],
    [{ kind: 'resume' }, playingNow(SONG, false), playingNow(SONG, false), false, 'still paused'],
    [{ kind: 'pause' }, playingNow(SONG), playingNow(SONG, false), true, 'paused'],
    [{ kind: 'pause' }, playingNow(SONG), stopped, true, 'stopped'],
    [{ kind: 'pause' }, playingNow(SONG), playingNow(SONG), false, 'still playing'],
    [{ kind: 'next' }, playingNow(SONG), playingNow(OTHER), true, 'another song'],
    [{ kind: 'next' }, playingNow(SONG), playingNow(SONG), false, 'the same song'],
    [{ kind: 'previous' }, null, playingNow(OTHER), true, 'a song, with nothing before to compare'],
    [{ kind: 'previous' }, playingNow(SONG), stopped, false, 'nothing at all'],
  ];
  for (const [press, before, after, shows, what] of cases) {
    assert.equal(pressShows(press, before, after), shows, `${press.kind}: ${what}`);
  }
});

test('only a real song or playlist address is offered as a tap, and only a song playing is marked', () => {
  assert.equal(playableSong(SONG), true, 'a song');
  for (const uri of ['spotify:episode:5googFqOqpopYdcvV22T3t', 'spotify:local:Layto:Beauty::200', 'spotify:track:7q', null, undefined]) {
    assert.equal(playableSong(uri), false, `not a tap: ${String(uri)}`);
  }
  assert.equal(playlistUriOf({ id: '1AbCdEfGhIjKlMnOpQrStU', uri: WEDDING }), WEDDING, 'a playlist plays by its own address');
  assert.equal(playlistUriOf({ id: '1AbCdEfGhIjKlMnOpQrStU', uri: null }), WEDDING, 'or by its id when the answer carried none');
  assert.equal(playlistUriOf({ id: 'abc', uri: null }), null, 'and never by anything the house would refuse');
  assert.equal(playingUri({ ok: true, data: playingNow(SONG) }), SONG, 'the song playing is the one marked');
  assert.equal(playingUri({ ok: true, data: playingNow(SONG, false) }), null, 'a paused song is not marked as playing');
  assert.equal(playingUri({ ok: false, trouble: { kind: 'restart' } }), null, 'nor anything when the read did not come back');
  assert.equal(playingUri(null), null, 'nor before the first read');
});

// ─── The keeper the app and the lock screen share ────────────────────

const SONG_A = 'spotify:track:463ahmflVo5cjEewhhbgAJ';
const SONG_B = 'spotify:track:5googFqOqpopYdcvV22T3t';
const nowOf = (uri: string, playing = true): SpotifyNowView => ({ playing, track: { name: 'A song', artist: 'Layto', uri, cover: null, album: null } });
const instant = { wait: async () => {} };

/** A house that answers presses with `press` and reads with `reads`, in turn; every ask is kept. */
function keeperHouse(reads: Array<() => Response>, press: () => Response = () => json({ ok: true })) {
  const asked: string[] = [];
  let n = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${init.body}` : ''}`);
    if (init?.method === 'POST') return press();
    const answer = reads[Math.min(n, reads.length - 1)];
    n += 1;
    return answer();
  };
  return { asked, fetcher };
}

test('the keeper: one press at a time, every press button waiting while it is out, and the one look after it', async () => {
  const { asked, fetcher } = keeperHouse([() => json(nowOf(SONG_A)), () => json(nowOf(SONG_B))]);
  const keeper = createSpotifyNow(fetcher, instant);
  await keeper.look();
  const first = keeper.press({ kind: 'next' }, 'now:next');
  assert.equal(keeper.state().pressing, 'now:next', 'the press is out, so every press button waits and this one turns');
  await keeper.press({ kind: 'previous' }, 'now:previous');
  await first;
  assert.deepEqual(asked, ['GET /api/spotify/now', 'POST /api/spotify/skip {"direction":"next"}', 'GET /api/spotify/now'],
    'one press and the one look after it; the press made while it was out is never sent');
  const read = keeper.state().read;
  assert.equal(read?.ok ? read.data.track?.uri : null, SONG_B, 'the look after the press is shown');
  assert.equal(keeper.state().pressing, null, 'nothing waits once it is back');
  assert.equal(keeper.state().notice, null, 'a press that worked says nothing');
});

test("the keeper: a press's sentence only when the look does not show what the owner asked for, and never on a page the owner has left", async () => {
  const NOWHERE = 'Open Spotify on your phone first, then try again.';
  const refused = () => json({ error: NOWHERE, reason: 'device' }, 409);
  const stuck = keeperHouse([() => json(nowOf(SONG_A))], refused);
  const shown = createSpotifyNow(stuck.fetcher, instant);
  await shown.look();
  await shown.press({ kind: 'next' }, 'now:next');
  assert.deepEqual(shown.state().notice, { where: 'now:next', trouble: { kind: 'problem', message: NOWHERE, device: true } }, 'refused and nothing moved: said by the button the owner pressed');
  shown.quiet();
  assert.equal(shown.state().notice, null, 'a refresh takes it away');

  const moved = keeperHouse([() => json(nowOf(SONG_A)), () => json(nowOf(SONG_B))], () => json({ error: 'Spotify answered oddly.', reason: 'spotify' }, 502));
  const believed = createSpotifyNow(moved.fetcher, instant);
  await believed.look();
  await believed.press({ kind: 'next' }, 'now:next');
  assert.equal(believed.state().notice, null, 'called an error, but the next song is playing: nothing said');

  const left = keeperHouse([() => json(nowOf(SONG_A))], refused);
  const gone = createSpotifyNow(left.fetcher, instant);
  await gone.look();
  const out = gone.press({ kind: 'next' }, 'now:next');
  gone.leave();
  await out;
  assert.equal(gone.state().notice, null, 'the owner left the page while it was out: nothing said');
});

test('the keeper: an older read of what is playing never replaces a newer one', () => {
  const keeper = createSpotifyNow(async () => json(nowOf(SONG_A)));
  const older = keeper.begin();
  const newer = keeper.begin();
  assert.equal(keeper.land(newer, { ok: true, data: nowOf(SONG_B) }), true, 'the newer read lands');
  assert.equal(keeper.land(older, { ok: true, data: nowOf(SONG_A) }), false, 'the older one, arriving last, does not');
  const read = keeper.state().read;
  assert.equal(read?.ok ? read.data.track?.uri : null, SONG_B, 'and the newer stays on screen');
});

// ─── A tapped song starts inside something, and search ───────────────

const TAP_SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const TAP_LIST = 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU';
const TAP_ALBUM = 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS';

test('a tapped song starts inside the playlist it was tapped in, else inside its album, else alone', async () => {
  assert.deepEqual(songPress({ uri: TAP_SONG, albumUri: TAP_ALBUM }, TAP_LIST), { kind: 'song', uri: TAP_SONG, playlistUri: TAP_LIST }, 'in a playlist, the playlist');
  assert.deepEqual(songPress({ uri: TAP_SONG, albumUri: TAP_ALBUM }), { kind: 'song', uri: TAP_SONG, albumUri: TAP_ALBUM }, 'elsewhere, its album');
  assert.deepEqual(songPress({ uri: TAP_SONG, albumUri: null }), { kind: 'song', uri: TAP_SONG }, 'with neither, the song alone');
  assert.deepEqual(songPress({ uri: TAP_SONG, albumUri: TAP_LIST }), { kind: 'song', uri: TAP_SONG }, 'an address that is not an album is not one');
  assert.deepEqual(songPress({ uri: TAP_SONG }, 'spotify:playlist:abc'), { kind: 'song', uri: TAP_SONG }, 'nor is a playlist the house would refuse');
  assert.equal(songPress({ uri: 'spotify:episode:5googFqOqpopYdcvV22T3t', albumUri: TAP_ALBUM }, TAP_LIST), null, 'an episode is still no tap');

  const presses: Array<[SpotifyPress, unknown]> = [
    [{ kind: 'song', uri: TAP_SONG, playlistUri: TAP_LIST }, { trackUri: TAP_SONG, playlistUri: TAP_LIST }],
    [{ kind: 'song', uri: TAP_SONG, albumUri: TAP_ALBUM }, { trackUri: TAP_SONG, albumUri: TAP_ALBUM }],
  ];
  for (const [press, body] of presses) {
    const { fetcher, asked } = pressHouse({ '/api/spotify/play': [() => json({ ok: true })] });
    assert.deepEqual(await sendPress(fetcher, press), { ok: true });
    assert.deepEqual(asked, [{ url: '/api/spotify/play', method: 'POST', body }], `the house is asked with ${JSON.stringify(body)}`);
  }
  assert.equal(pressShows({ kind: 'song', uri: TAP_SONG, albumUri: TAP_ALBUM }, null, { playing: true, track: { name: 'Rain', artist: 'Sleep Token', uri: TAP_SONG, cover: null, album: null } }), true,
    'the look after it believes the song it started at');
});

test('a search asks the house once, with their words as one piece, and an old house asks for a restart', async () => {
  const found = { query: 'meet me in the woods', tracks: [{ name: 'Meet Me in the Woods', artist: 'Lord Huron', uri: TAP_SONG, cover: null, albumUri: TAP_ALBUM }] };
  const newHouse = house({ '/api/spotify/search?q=meet%20me%20in%20the%20woods%20%26%20more': () => json(found) });
  assert.deepEqual(await searchSpotify(newHouse.fetcher, '  meet me in the woods & more '), { ok: true, data: found });
  assert.deepEqual(newHouse.asked, ['/api/spotify/search?q=meet%20me%20in%20the%20woods%20%26%20more'], 'asked once, the words never read as more of the address');

  const oldHouse = house({ '/api/spotify/search?q=rain': html });
  assert.deepEqual(await searchSpotify(oldHouse.fetcher, 'rain'), { ok: false, trouble: { kind: 'restart' } }, 'a house from before search answers with its page');

  const refused = house({ '/api/spotify/search?q=rain': () => json({ error: 'Search takes at most 100 letters.', reason: 'spotify' }, 400) });
  assert.deepEqual(await searchSpotify(refused.fetcher, 'rain'), { ok: false, trouble: { kind: 'problem', message: 'Search takes at most 100 letters.' } });

  const strange = house({ '/api/spotify/search?q=rain': () => json({ query: 'rain', tracks: [{ name: 'Rain', artist: 'x', uri: TAP_SONG, cover: null, albumUri: 42 }] }) });
  assert.deepEqual(await searchSpotify(strange.fetcher, 'rain'), { ok: false, trouble: { kind: 'restart' } }, 'a song whose album is not an address is not the house\'s answer');
});

test('nowhere to play wakes Spotify once and sends the press again; no wake, or a wake that failed, says the old sentence', async () => {
  const nowhere = () => json({ error: NOWHERE, reason: 'device' }, 409);
  async function run(answers: Array<() => Response>, wake: (() => Promise<boolean>) | undefined) {
    const house = pressHouse({ '/api/spotify/play': answers, '/api/spotify/now': [() => json(playingNow(SONG))] });
    let wakes = 0;
    const outcome = await pressAndLook(house.fetcher, { kind: 'song', uri: SONG }, null, {
      wait: async () => {},
      wake: wake ? async () => { wakes += 1; return wake(); } : undefined,
    });
    return { outcome, wakes, plays: house.asked.filter((ask) => ask.url === '/api/spotify/play').length };
  }
  const woke = await run([nowhere, () => json({ ok: true })], async () => true);
  assert.deepEqual([woke.wakes, woke.plays, woke.outcome.trouble], [1, 2, null], 'woken, sent again, and playing');
  const stillNowhere = await run([nowhere, nowhere], async () => true);
  assert.deepEqual([stillNowhere.wakes, stillNowhere.plays], [1, 2], 'only one wake and one second try');
  const refused = await run([nowhere], async () => false);
  assert.deepEqual([refused.wakes, refused.plays], [1, 1], 'a wake that did not take is not followed by a second press');
  const browser = await run([nowhere], undefined);
  assert.deepEqual([browser.plays, browser.outcome.now?.playing], [1, true], 'with nothing to wake, the press goes once as before');
  const other = await run([() => json({ error: 'That is not a Spotify song.', reason: 'spotify' }, 400)], async () => true);
  assert.equal(other.wakes, 0, 'only nowhere to play wakes Spotify');
});
