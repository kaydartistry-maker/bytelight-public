// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The player, their library and their playlists, as the phone decides them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockOf, isPlayerView, loadLiked, loadSaved, moveTargets, nextRepeat, playlistsForAdding, positionNow, sendSpotify, spotifyActions } from './spotify-more';

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const reply = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('repeat goes off, then the playlist, then the song, then off', () => {
  assert.deepEqual([nextRepeat('off'), nextRepeat('context'), nextRepeat('track')], ['context', 'track', 'off']);
});

test('times read the way a player shows them', () => {
  assert.deepEqual([clockOf(0), clockOf(65_000), clockOf(3_725_000), clockOf(null), clockOf(-5)], ['0:00', '1:05', '1:02:05', '0:00', '0:00']);
});

test('the place moves on with the clock while playing, stays put while paused, and stops at the end', () => {
  assert.equal(positionNow({ playing: true, progressMs: 10_000, durationMs: 200_000 }, 1_000, 6_000), 15_000);
  assert.equal(positionNow({ playing: false, progressMs: 10_000, durationMs: 200_000 }, 1_000, 60_000), 10_000);
  assert.equal(positionNow({ playing: true, progressMs: 199_000, durationMs: 200_000 }, 0, 60_000), 200_000);
  assert.equal(positionNow({ playing: true, progressMs: null, durationMs: null }, 0, 1), null);
});

test('only their own playlists are offered for adding, and a song moves only within the list', () => {
  const lists = [{ id: 'a', name: 'Mine', tracks: 1, uri: null, cover: null, mine: true }, { id: 'b', name: 'Theirs', tracks: 1, uri: null, cover: null, mine: false }, { id: 'c', name: 'Old', tracks: 1, uri: null, cover: null }];
  assert.deepEqual(playlistsForAdding(lists).map((l) => l.id), ['a']);
  assert.deepEqual(playlistsForAdding(null), []);
  assert.deepEqual([moveTargets(0, 3), moveTargets(1, 3), moveTargets(2, 3), moveTargets(0, 1)], [{ up: null, down: 1 }, { up: 0, down: 2 }, { up: 1, down: null }, { up: null, down: null }]);
});

test('each press goes to its own door with only what it needs', () => {
  assert.deepEqual(spotifyActions.volume(140.4), ['POST', '/api/spotify/volume', { percent: 100 }]);
  assert.deepEqual(spotifyActions.seek(61_234.6), ['POST', '/api/spotify/seek', { positionMs: 61_235 }]);
  assert.deepEqual(spotifyActions.newPlaylist('Late drive', '  '), ['POST', '/api/spotify/playlists', { name: 'Late drive' }]);
  assert.deepEqual(spotifyActions.move('abc', 3, 1), ['POST', '/api/spotify/playlists/abc/move', { from: 3, to: 1 }]);
  assert.deepEqual(spotifyActions.cover('abc', 'data:image/png;base64,AA')[0], 'PUT');
  assert.deepEqual(spotifyActions.rename('abc', 'New')[0], 'PATCH');
});

test('a press is a yes only on ok true; a refusal is the house sentence; an old backend asks for a restart', async () => {
  assert.equal((await sendSpotify(reply(200, { ok: true }), 'POST', '/x', {})).ok, true);
  const refused = await sendSpotify(reply(400, { error: 'Volume is a whole number from 0 to 100.', reason: 'spotify' }), 'POST', '/x', {});
  assert.deepEqual(refused, { ok: false, trouble: { kind: 'problem', message: 'Volume is a whole number from 0 to 100.' } });
  const signin = await sendSpotify(reply(502, { error: 'Sign in again.', reason: 'signin', authUrl: 'https://w.example/auth' }), 'POST', '/x', {});
  assert.deepEqual(signin, { ok: false, trouble: { kind: 'signin', message: 'Sign in again.', authUrl: 'https://w.example/auth' } });
  assert.deepEqual(await sendSpotify(reply(404, '<html>Cannot POST</html>'), 'POST', '/x', {}), { ok: false, trouble: { kind: 'restart' } });
  assert.deepEqual(await sendSpotify(reply(200, '<html>the app</html>'), 'POST', '/x', {}), { ok: false, trouble: { kind: 'restart' } });
});

test('hearts are only asked about for songs, and nothing to ask is an empty yes', async () => {
  let asked = '';
  const fetcher = async (url: string) => { asked = url; return new Response(JSON.stringify({ saved: { [SONG]: true } })); };
  assert.deepEqual(await loadSaved(fetcher, [null, 'spotify:episode:x']), { ok: true, data: { saved: {} } });
  assert.equal(asked, '', 'nothing was asked');
  const read = await loadSaved(fetcher, [SONG, SONG]);
  assert.ok(read.ok && read.data.saved[SONG] === true);
  assert.equal(asked, `/api/spotify/saved?uris=${encodeURIComponent(SONG)}`);
});

test('Liked Songs come back shaped as a playlist page, and a player answer is shape-checked', async () => {
  const read = await loadLiked(async () => new Response(JSON.stringify({ tracks: [{ name: 'Rain', artist: 'Sleep Token', uri: SONG, cover: null }] })));
  assert.ok(read.ok && read.data.id === 'liked' && read.data.tracks[0].name === 'Rain');
  assert.equal(isPlayerView({ active: true, playing: true, shuffle: false, repeat: 'context', volume: 50, progressMs: 1, durationMs: 2, device: { id: 'd', name: 'moto', type: 'Smartphone', active: true, volume: 50 } }), true);
  assert.equal(isPlayerView({ active: true, playing: true, shuffle: false, repeat: 'sometimes', volume: 50, progressMs: 1, durationMs: 2, device: null }), false);
});
