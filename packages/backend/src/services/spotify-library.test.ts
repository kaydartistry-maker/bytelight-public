// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The player, their library and their playlists (Oct 23 2026): the readers, the
// sentence for a permission the sign-in never granted, and the cover maker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectViewFrom,
  coverJpegBase64,
  problemFrom,
  readCoverRequest,
  readDevices,
  readPlayer,
  readPlaylists,
  readSaved,
} from './spotify.js';

const SERVER = 'https://spotify-example.someone.workers.dev/mcp';

test('the player reads what the worker said, and nothing active reads as idle', () => {
  assert.deepEqual(readPlayer({ active: false }), { active: false, playing: false, shuffle: false, repeat: 'off', volume: null, progressMs: null, durationMs: null, device: null });
  const view = readPlayer({ active: true, playing: true, shuffle: true, repeat: 'track', progress_ms: 1200, duration_ms: 200000, device: { id: 'd1', name: 'pixel', type: 'Smartphone', volume_percent: 64 } });
  assert.deepEqual(view, { active: true, playing: true, shuffle: true, repeat: 'track', volume: 64, progressMs: 1200, durationMs: 200000, device: { id: 'd1', name: 'pixel', type: 'Smartphone', active: true, volume: 64 } });
  const fixed = readPlayer({ active: true, playing: false, repeat: 'nonsense', device: { id: 'd2', name: 'TV', type: 'TV', volume_percent: 30, supports_volume: false } });
  assert.equal(fixed.volume, null, 'a device that cannot be turned up has no volume to show');
  assert.equal(fixed.repeat, 'off');
});

test('devices come back with the one playing first; a device with no id is left out', () => {
  const { devices } = readDevices([{ id: 'a', name: 'Laptop', type: 'Computer', is_active: false }, { name: 'ghost' }, { id: 'b', name: 'moto', type: 'Smartphone', is_active: true, volume_percent: 140 }]);
  assert.deepEqual(devices.map((d) => [d.name, d.active, d.volume]), [['moto', true, 100], ['Laptop', false, null]]);
});

test('saved answers yes only for a song the worker said yes about', () => {
  assert.deepEqual(readSaved({ 'spotify:track:a': true, 'spotify:track:b': 'yes' }, ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']).saved, { 'spotify:track:a': true, 'spotify:track:b': false, 'spotify:track:c': false });
});

test('a playlist says whether it is theirs when the worker said, and stays quiet when it did not', () => {
  const { items } = readPlaylists([{ name: 'Mine', id: 'aaa', uri: 'spotify:playlist:aaa', mine: true }, { name: 'Theirs', id: 'bbb', uri: 'spotify:playlist:bbb', mine: false }, { name: 'Old worker', id: 'ccc', uri: 'spotify:playlist:ccc' }]);
  assert.deepEqual(items.map((p) => p.mine), [true, false, undefined]);
});

test('a permission the sign-in never granted says to sign in again, with the sign-in page', () => {
  const problem = problemFrom('Spotify API error (403): {"error": {"status": 403, "message": "Insufficient client scope" } }', SERVER).toProblem();
  assert.equal(problem.reason, 'signin');
  assert.equal(problem.error, 'Spotify needs one more yes for that. Open the sign-in page, say yes to Spotify, and try again.');
  assert.equal(problem.authUrl, 'https://spotify-example.someone.workers.dev/auth');
});

test('a cover picture is read from a data URL, and anything else is refused', () => {
  assert.equal(readCoverRequest({ image: 'data:image/png;base64,iVBORw0KGgo=' }).ok, true);
  for (const body of [{}, { image: 'https://example.com/a.png' }, { image: 'data:text/html;base64,PGI+' }, { image: 'data:image/png;base64,' }, { image: 'data:image/png;base64,AAAA', extra: 1 }]) {
    assert.equal(readCoverRequest(body).ok, false, JSON.stringify(body));
  }
});

test('any picture becomes a square JPEG within Spotify\'s 256 KB', async () => {
  const { default: sharp } = await import('sharp');
  // Noise is the hardest thing to make small: if this fits, a photo will.
  const width = 2400, height = 1200;
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const png = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const base64 = await coverJpegBase64(png);
  assert.ok(base64.length <= 256 * 1024, `${base64.length} bytes of base64`);
  const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, meta.height, 'square');
});

test("the phone kit's client id and redirect are read off a redirect to Spotify, and anything else is refused", () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(connectViewFrom(`https://accounts.spotify.com/authorize?client_id=${id}&response_type=code&redirect_uri=https%3A%2F%2Fw.example%2Fcallback&scope=x`), { clientId: id, redirectUri: 'https://w.example/callback' });
  assert.equal(connectViewFrom(null), null);
  assert.equal(connectViewFrom(`https://evil.example/authorize?client_id=${id}&redirect_uri=https%3A%2F%2Fw.example`), null);
  assert.equal(connectViewFrom('https://accounts.spotify.com/authorize?client_id=short&redirect_uri=https%3A%2F%2Fw.example'), null);
});
