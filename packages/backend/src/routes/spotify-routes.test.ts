// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify, for seeing, over HTTP: the phone's door. The shapes asserted here
// are the contract the phone is built against.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

// The door has to be shut without a session, so this house has a password.
process.env.APP_PASSWORD = 'spotify-test-password';
const { loadConfig } = await import('../config.js');
loadConfig();

const { initDb } = await import('../services/db/init.js');
const { createWebSession } = await import('../services/db/web-sessions.js');
const { createSpotify, setSpotifyForTest, SpotifyError } = await import('../services/spotify.js');
const spotifyRoutes = (await import('./spotify.js')).default;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'https://spotify-example.someone.workers.dev/mcp';
const SONG_A = 'spotify:track:5googFqOqpopYdcvV22T3t';
const SONG_B = 'spotify:track:7voqYiZoYUyEJnZWWa7d6d';
const LIST = '1AbCdEfGhIjKlMnOpQrStU';
const TOKEN = 'spotify-test-session';

function toolAnswer(value: unknown): Response {
  const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

async function door() {
  initDb(':memory:');
  createWebSession({
    id: 'spotify-test', token: TOKEN, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const app = express();
  // The house parses JSON bodies before any route (server.ts), so the door is tried the same way.
  app.use(express.json());
  app.use('/api/spotify', spotifyRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    async get(path: string, signedIn = true) {
      const res = await fetch(`${base}${path}`, { headers: signedIn ? { cookie: `bytelight_session=${TOKEN}` } : {} });
      return { status: res.status, cache: res.headers.get('cache-control'), json: await res.json() as any };
    },
    /** A press the way the phone sends one: POST, a JSON body (or none), and the session cookie. */
    async post(path: string, body?: unknown, signedIn = true) {
      const headers: Record<string, string> = signedIn ? { cookie: `bytelight_session=${TOKEN}` } : {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, cache: res.headers.get('cache-control'), json: await res.json() as any };
    },
    /** Any method, the way the phone sends it: a JSON body and the session cookie. */
    async send(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = { cookie: `bytelight_session=${TOKEN}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() as any };
    },
    close: () => server.close(),
  };
}

test.afterEach(() => setSpotifyForTest(null));

test('the phone reads what is playing, their recent songs, their playlists and one playlist, only with a session', async () => {
  const asked: Array<{ tool: string; args: unknown }> = [];
  setSpotifyForTest(createSpotify({
    server: () => ({ url: SERVER, apiKey: null }),
    coverFile: null,
    fetch: async (url, init) => {
      if (url !== SERVER) {
        const page = new URL(url).searchParams.get('url') ?? '';
        return new Response(JSON.stringify({ thumbnail_url: `https://i.scdn.co/image/${page.split('/').pop()}` }));
      }
      const { params } = JSON.parse(String(init?.body));
      asked.push({ tool: params.name, args: params.arguments });
      switch (params.name) {
        case 'spotify_now_playing': return toolAnswer({ playing: true, track: 'Beauty', artist: 'Layto', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ' });
        case 'spotify_recently_played': return toolAnswer([{ track: 'MY HEAD', artist: 'Layto', played_at: '2026-10-20T00:17:27.554Z', uri: 'spotify:track:7qItfeoWaFGMij40oPR96M' }]);
        case 'spotify_get_playlists': return toolAnswer([{ name: 'Sunday Mix', id: '1AbCdEfGhIjKlMnOpQrStU', tracks: 5, uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU' }]);
        case 'spotify_get_playlist_tracks': return toolAnswer([{ track: 'Villain', artist: 'MISSIO', uri: 'spotify:track:5googFqOqpopYdcvV22T3t' }]);
        default: throw new Error(`asked for ${params.name}`);
      }
    },
  }));
  const phone = await door();
  try {
    const shut = await phone.get('/api/spotify/now', false);
    assert.equal(shut.status, 401, 'no session, no music');
    assert.deepEqual(asked, [], 'and Spotify was never asked');

    const now = await phone.get('/api/spotify/now');
    assert.equal(now.status, 200);
    assert.equal(now.cache, 'no-store', 'what is playing is never kept by anything in between');
    assert.deepEqual(now.json, {
      playing: true,
      track: { name: 'Beauty', artist: 'Layto', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', cover: 'https://i.scdn.co/image/463ahmflVo5cjEewhhbgAJ', album: null },
    });

    const recent = await phone.get('/api/spotify/recent');
    assert.deepEqual(recent.json, { tracks: [{
      name: 'MY HEAD', artist: 'Layto', uri: 'spotify:track:7qItfeoWaFGMij40oPR96M', cover: 'https://i.scdn.co/image/7qItfeoWaFGMij40oPR96M', playedAt: '2026-10-20T00:17:27.554Z',
    }] });

    const lists = await phone.get('/api/spotify/playlists');
    assert.deepEqual(lists.json, { playlists: [{
      id: '1AbCdEfGhIjKlMnOpQrStU', name: 'Sunday Mix', tracks: 5, uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU', cover: 'https://i.scdn.co/image/1AbCdEfGhIjKlMnOpQrStU',
    }] });

    const one = await phone.get('/api/spotify/playlists/1AbCdEfGhIjKlMnOpQrStU');
    assert.deepEqual(one.json, { id: '1AbCdEfGhIjKlMnOpQrStU', tracks: [{
      name: 'Villain', artist: 'MISSIO', uri: 'spotify:track:5googFqOqpopYdcvV22T3t', cover: 'https://i.scdn.co/image/5googFqOqpopYdcvV22T3t',
    }] });
    assert.deepEqual(asked.at(-1), { tool: 'spotify_get_playlist_tracks', args: { playlist_id: '1AbCdEfGhIjKlMnOpQrStU', limit: 50, offset: 0 } });

    const strange = await phone.get('/api/spotify/playlists/..%2F..%2Fnope');
    assert.equal(strange.status, 400);
    assert.deepEqual(strange.json, { error: 'That is not a Spotify playlist id.', reason: 'spotify' });
    assert.equal(asked.length, 4, 'a strange id never reaches Spotify');
  } finally {
    phone.close();
  }
});

test('when Spotify cannot be read the phone gets one plain sentence, never a page', async () => {
  const problems: Record<string, Error> = {
    now: new SpotifyError('signin', 'Lapsed, in a sentence.', 'https://spotify-example.someone.workers.dev/auth'),
    recent: new SpotifyError('unset', 'The house has no Spotify server yet. Add one in Integrations > MCP.'),
    playlists: new Error('a bug nobody saw coming'),
  };
  const fail = (key: string) => async () => { throw problems[key]; };
  setSpotifyForTest({ now: fail('now'), recent: fail('recent'), playlists: fail('playlists'), playlistTracks: fail('now'), search: fail('now'), play: fail('now'), pause: fail('now'), skip: fail('now') } as unknown as Parameters<typeof setSpotifyForTest>[0]);
  const phone = await door();
  const quiet = console.error;
  console.error = () => {};
  try {
    const lapsed = await phone.get('/api/spotify/now');
    assert.equal(lapsed.status, 502);
    assert.deepEqual(lapsed.json, { error: 'Lapsed, in a sentence.', reason: 'signin', authUrl: 'https://spotify-example.someone.workers.dev/auth' });

    const unset = await phone.get('/api/spotify/recent');
    assert.equal(unset.status, 503);
    assert.deepEqual(unset.json, { error: 'The house has no Spotify server yet. Add one in Integrations > MCP.', reason: 'unset' });

    const broken = await phone.get('/api/spotify/playlists');
    assert.equal(broken.status, 500);
    assert.deepEqual(broken.json, { error: 'Spotify could not be read just now; the server log has the details.', reason: 'unreachable' });
  } finally {
    console.error = quiet;
    phone.close();
  }
});

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const WEDDING = 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU';

test('the phone plays, pauses and skips through the house, only with a session, and a strange press never reaches Spotify', async () => {
  const asked: Array<{ tool: string; args: unknown }> = [];
  setSpotifyForTest(createSpotify({
    server: () => ({ url: SERVER, apiKey: null }),
    coverFile: null,
    log: () => {},
    fetch: async (url, init) => {
      assert.equal(url, SERVER, 'a press only ever goes to the owner Spotify server');
      const { params } = JSON.parse(String(init?.body));
      asked.push({ tool: params.name, args: params.arguments });
      return toolAnswer('Done');
    },
  }));
  const phone = await door();
  try {
    const shut = await phone.post('/api/spotify/play', { trackUri: SONG }, false);
    assert.equal(shut.status, 401, 'no session, no music');
    assert.equal((await phone.post('/api/spotify/pause', undefined, false)).status, 401, 'no session, no pause');
    assert.equal((await phone.post('/api/spotify/skip', { direction: 'next' }, false)).status, 401, 'no session, no skip');
    assert.deepEqual(asked, [], 'and Spotify was never asked');

    const song = await phone.post('/api/spotify/play', { trackUri: SONG });
    assert.equal(song.status, 200, 'a song is played');
    assert.deepEqual(song.json, { ok: true }, 'and the phone is told the server took it');
    assert.equal(song.cache, 'no-store', 'a press is never kept by anything in between');
    assert.deepEqual((await phone.post('/api/spotify/play', { playlistUri: WEDDING })).json, { ok: true }, 'a playlist is played');
    assert.deepEqual((await phone.post('/api/spotify/play', { trackUri: SONG, playlistUri: WEDDING })).json, { ok: true }, 'a song in its playlist is played');
    assert.deepEqual((await phone.post('/api/spotify/play', {})).json, { ok: true }, 'an empty play carries on');
    assert.deepEqual((await phone.post('/api/spotify/play')).json, { ok: true }, 'so does a play with no body at all');
    assert.deepEqual((await phone.post('/api/spotify/pause')).json, { ok: true }, 'pause');
    assert.deepEqual((await phone.post('/api/spotify/skip', { direction: 'next' })).json, { ok: true }, 'next');
    assert.deepEqual((await phone.post('/api/spotify/skip', { direction: 'previous' })).json, { ok: true }, 'previous');
    assert.deepEqual(asked, [
      { tool: 'spotify_play', args: { track_uri: SONG } },
      { tool: 'spotify_play', args: { playlist_uri: WEDDING } },
      { tool: 'spotify_play', args: { context_uri: WEDDING, offset_uri: SONG } },
      { tool: 'spotify_play', args: {} },
      { tool: 'spotify_play', args: {} },
      { tool: 'spotify_pause', args: {} },
      { tool: 'spotify_skip', args: { direction: 'next' } },
      { tool: 'spotify_skip', args: { direction: 'previous' } },
    ], 'each press reached their server once, with only what it needed');

    const strange: Array<[string, unknown, string]> = [
      ['/api/spotify/play', { trackUri: 'spotify:track:nope' }, 'That is not a Spotify song.'],
      ['/api/spotify/play', { trackUri: '../../me/player/volume?volume_percent=100' }, 'That is not a Spotify song.'],
      ['/api/spotify/play', { playlistUri: SONG }, 'That is not a Spotify playlist.'],
      ['/api/spotify/play', { playlistUri: WEDDING, albumUri: 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS' }, 'Play takes a playlist or an album, not both.'],
      ['/api/spotify/play', { trackUri: SONG, albumUri: WEDDING }, 'That is not a Spotify album.'],
      ['/api/spotify/play', { trackUri: SONG, deviceId: 'the owner-laptop' }, 'Play takes a song, a playlist or an album, and nothing else.'],
      ['/api/spotify/play', [SONG], 'Play takes a song, a playlist or an album, and nothing else.'],
      ['/api/spotify/skip', { direction: 'sideways' }, 'Skip goes to the next song or the previous one, and nothing else.'],
      ['/api/spotify/skip', {}, 'Skip goes to the next song or the previous one, and nothing else.'],
      ['/api/spotify/pause', { volume: 100 }, 'Pause takes nothing.'],
    ];
    for (const [path, body, sentence] of strange) {
      const refused = await phone.post(path, body);
      assert.equal(refused.status, 400, `${path} ${JSON.stringify(body)} is refused`);
      assert.deepEqual(refused.json, { error: sentence, reason: 'spotify' }, `${path} ${JSON.stringify(body)} is refused in a plain sentence`);
    }
    assert.equal(asked.length, 8, 'no strange press ever reached Spotify');
  } finally {
    phone.close();
  }
});

test('when a press cannot be taken the phone gets one plain sentence, never a page', async () => {
  const refusals: Record<string, Error> = {
    play: new SpotifyError('device', 'Open Spotify on your phone first, then try again.'),
    pause: new SpotifyError('signin', 'Lapsed, in a sentence.', 'https://spotify-example.someone.workers.dev/auth'),
    skip: new Error('a bug nobody saw coming'),
  };
  const fail = (key: string) => async () => { throw refusals[key]; };
  setSpotifyForTest({ now: fail('skip'), recent: fail('skip'), playlists: fail('skip'), playlistTracks: fail('skip'), search: fail('skip'), play: fail('play'), pause: fail('pause'), skip: fail('skip') } as unknown as Parameters<typeof setSpotifyForTest>[0]);
  const phone = await door();
  const quiet = console.error;
  console.error = () => {};
  try {
    const nowhere = await phone.post('/api/spotify/play', { trackUri: SONG });
    assert.equal(nowhere.status, 409, 'nowhere to play is the state of the owner devices, not a broken server');
    assert.deepEqual(nowhere.json, { error: 'Open Spotify on your phone first, then try again.', reason: 'device' }, 'said as what to do');

    const lapsed = await phone.post('/api/spotify/pause');
    assert.equal(lapsed.status, 502, 'a lapsed sign-in on a press');
    assert.deepEqual(lapsed.json, { error: 'Lapsed, in a sentence.', reason: 'signin', authUrl: 'https://spotify-example.someone.workers.dev/auth' }, 'with its sign-in page');

    const broken = await phone.post('/api/spotify/skip', { direction: 'next' });
    assert.equal(broken.status, 500, 'a bug is a 500');
    assert.deepEqual(broken.json, { error: 'Spotify could not be asked just now; the server log has the details.', reason: 'unreachable' }, 'said as a press, not a read');
  } finally {
    console.error = quiet;
    phone.close();
  }

  setSpotifyForTest(createSpotify({ server: () => new SpotifyError('unset', 'The house has no Spotify server yet. Add one in Integrations > MCP.'), coverFile: null, log: () => {} }));
  const unset = await door();
  try {
    const none = await unset.post('/api/spotify/skip', { direction: 'previous' });
    assert.equal(none.status, 503, 'no Spotify server in the house');
    assert.deepEqual(none.json, { error: 'The house has no Spotify server yet. Add one in Integrations > MCP.', reason: 'unset' }, 'said plainly');
  } finally {
    unset.close();
  }
});

// byte-light composes every /api router in routes/api.ts (server.ts mounts
// only /api), so the door is checked there, behind the auth boundary.
test('api.ts mounts the phone door at /api/spotify, behind the auth boundary', () => {
  const api = readFileSync(join(SRC, 'routes', 'api.ts'), 'utf8');
  assert.match(api, /^import spotifyRouter from '\.\/spotify\.js';$/m);
  assert.match(api, /^router\.use\('\/spotify', spotifyRouter\);$/m);
  assert.ok(api.indexOf("router.use('/spotify', spotifyRouter);") > api.indexOf('router.use(authMiddleware);'), 'mounted after authMiddleware');
});

test('the phone searches through the house, only with a session, and empty words never reach Spotify', async () => {
  const asked: Array<{ tool: string; args: unknown }> = [];
  setSpotifyForTest(createSpotify({
    server: () => ({ url: SERVER, apiKey: null }),
    coverFile: null,
    fetch: async (url, init) => {
      assert.equal(url, SERVER, 'a search only ever goes to the owner Spotify server; these songs bring their own covers');
      const { params } = JSON.parse(String(init?.body));
      asked.push({ tool: params.name, args: params.arguments });
      return toolAnswer([{ name: 'Rain', artists: [{ name: 'Sleep Token' }], album: { name: 'Sundowning', uri: 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS', images: [{ url: 'https://i.scdn.co/image/sundowning' }] }, uri: SONG }]);
    },
  }));
  const phone = await door();
  try {
    assert.equal((await phone.get('/api/spotify/search?q=rain', false)).status, 401, 'no session, no search');
    const found = await phone.get(`/api/spotify/search?q=${encodeURIComponent('rain  sleep token')}`);
    assert.equal(found.status, 200);
    assert.equal(found.cache, 'no-store', 'a search is never kept by anything in between');
    assert.deepEqual(found.json, {
      query: 'rain sleep token',
      tracks: [{ name: 'Rain', artist: 'Sleep Token', uri: SONG, cover: 'https://i.scdn.co/image/sundowning', albumUri: 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS' }],
    });
    for (const path of ['/api/spotify/search', '/api/spotify/search?q=', '/api/spotify/search?q=%20%20', '/api/spotify/search?q=a&q=b']) {
      const refused = await phone.get(path);
      assert.equal(refused.status, 400, `${path} is refused`);
      assert.deepEqual(refused.json, { error: 'Search needs something to look for.', reason: 'spotify' });
    }
    assert.deepEqual((await phone.get(`/api/spotify/search?q=${'a'.repeat(101)}`)).json, { error: 'Search takes at most 100 letters.', reason: 'spotify' });
    assert.deepEqual(asked, [{ tool: 'spotify_search', args: { query: 'rain sleep token', type: 'track', limit: 10 } }], 'only the one good search reached their server');
  } finally {
    phone.close();
  }
});

test('the player, hearts and playlist building each reach the right tool, and a bad body never leaves the house', async () => {
  const asked: Array<{ tool: string; args: any }> = [];
  setSpotifyForTest(createSpotify({
    server: () => ({ url: SERVER, apiKey: null }),
    coverFile: null,
    log: () => {},
    fetch: async (url, init) => {
      if (url !== SERVER) return new Response('{}', { status: 404 });
      const { params } = JSON.parse(String(init?.body));
      asked.push({ tool: params.name, args: params.arguments });
      const value = params.name === 'spotify_create_playlist' ? { id: '0123456789abcdefABCDEF', name: params.arguments.name }
        : params.name === 'spotify_player_state' ? { active: true, playing: true, shuffle: true, repeat: 'context', progress_ms: 5, duration_ms: 9, device: { id: 'dev1', name: 'moto', type: 'Smartphone', volume_percent: 55 } }
        : params.name === 'spotify_devices' ? [{ id: 'dev2', name: 'Laptop', type: 'Computer', is_active: false }, { id: 'dev1', name: 'moto', type: 'Smartphone', is_active: true, volume_percent: 55 }]
        : params.name === 'spotify_is_saved' ? { [SONG_A]: true }
        : 'ok';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
    },
  }));
  const phone = await door();
  try {
    const player = await phone.get('/api/spotify/player');
    assert.deepEqual([player.status, player.json.shuffle, player.json.repeat, player.json.volume, player.json.device.name], [200, true, 'context', 55, 'moto']);
    const devices = await phone.get('/api/spotify/devices');
    assert.deepEqual(devices.json.devices.map((d: any) => d.name), ['moto', 'Laptop'], 'the one playing first');
    const saved = await phone.get(`/api/spotify/saved?uris=${SONG_A},${SONG_B}`);
    assert.deepEqual(saved.json.saved, { [SONG_A]: true, [SONG_B]: false });

    for (const [path, body] of [
      ['/api/spotify/like', { uri: SONG_A, liked: true }],
      ['/api/spotify/like', { uri: SONG_A, liked: false }],
      ['/api/spotify/shuffle', { on: false }],
      ['/api/spotify/repeat', { mode: 'track' }],
      ['/api/spotify/volume', { percent: 30 }],
      ['/api/spotify/seek', { positionMs: 61000 }],
      ['/api/spotify/transfer', { deviceId: 'dev2' }],
      [`/api/spotify/playlists/${LIST}/add`, { uris: [SONG_A, SONG_B, SONG_A] }],
      [`/api/spotify/playlists/${LIST}/remove`, { uris: [SONG_B] }],
      [`/api/spotify/playlists/${LIST}/move`, { from: 0, to: 2 }],
      [`/api/spotify/playlists/${LIST}/move`, { from: 3, to: 1 }],
    ] as const) {
      const res = await phone.post(path, body);
      assert.deepEqual([res.status, res.json], [200, { ok: true }], `${path} ${JSON.stringify(body)}`);
    }
    const made = await phone.post('/api/spotify/playlists', { name: '  Late   drive ', description: 'for the road' });
    assert.equal(made.json.playlist.id, '0123456789abcdefABCDEF');
    assert.equal(made.json.playlist.mine, true);
    const renamed = await phone.send('PATCH', `/api/spotify/playlists/${LIST}`, { name: 'Later drive' });
    assert.deepEqual(renamed.json, { ok: true });

    assert.deepEqual(asked.slice(3).map((a) => [a.tool, a.args]), [
      ['spotify_save', { uris: [SONG_A] }],
      ['spotify_unsave', { uris: [SONG_A] }],
      ['spotify_shuffle', { state: false }],
      ['spotify_repeat', { state: 'track' }],
      ['spotify_volume', { percent: 30 }],
      ['spotify_seek', { position_ms: 61000 }],
      ['spotify_transfer', { device_id: 'dev2', play: true }],
      ['spotify_add_tracks', { playlist_id: LIST, track_uris: [SONG_A, SONG_B] }],
      ['spotify_remove_tracks', { playlist_id: LIST, track_uris: [SONG_B] }],
      ['spotify_reorder_tracks', { playlist_id: LIST, range_start: 0, insert_before: 3, range_length: 1 }],
      ['spotify_reorder_tracks', { playlist_id: LIST, range_start: 3, insert_before: 1, range_length: 1 }],
      ['spotify_create_playlist', { name: 'Late drive', description: 'for the road', public: false }],
      ['spotify_update_playlist', { playlist_id: LIST, name: 'Later drive' }],
    ], 'one call each, and a song moved down lands where the owner put it');

    const before = asked.length;
    for (const [method, path, body] of [
      ['POST', '/api/spotify/like', { uri: 'spotify:playlist:0123456789abcdefABCDEF', liked: true }],
      ['POST', '/api/spotify/like', { uri: SONG_A }],
      ['POST', '/api/spotify/volume', { percent: 101 }],
      ['POST', '/api/spotify/volume', { percent: 50.5 }],
      ['POST', '/api/spotify/repeat', { mode: 'forever' }],
      ['POST', '/api/spotify/seek', { positionMs: -1 }],
      ['POST', '/api/spotify/transfer', { deviceId: '../x' }],
      ['POST', '/api/spotify/shuffle', { on: 'yes' }],
      ['POST', '/api/spotify/playlists', { name: '   ' }],
      ['POST', '/api/spotify/playlists', { name: 'x'.repeat(101) }],
      ['POST', '/api/spotify/playlists', { name: 'ok', public: true }],
      ['PATCH', `/api/spotify/playlists/${LIST}`, {}],
      ['POST', `/api/spotify/playlists/${LIST}/add`, { uris: [] }],
      ['POST', `/api/spotify/playlists/${LIST}/add`, { uris: ['spotify:album:0123456789abcdefABCDEF'] }],
      ['POST', `/api/spotify/playlists/${LIST}/move`, { from: 2, to: 2 }],
      ['POST', '/api/spotify/playlists/not-an-id!/add', { uris: [SONG_A] }],
      ['PUT', `/api/spotify/playlists/${LIST}/cover`, { image: 'data:text/html;base64,PGI+' }],
      ['GET', `/api/spotify/saved?uris=${LIST}`, undefined],
    ] as const) {
      const res = method === 'GET' ? await phone.get(path) : await phone.send(method, path, body);
      assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)} is refused`);
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal(asked.length, before, 'nothing refused reached their server');
  } finally {
    phone.close();
  }
});
